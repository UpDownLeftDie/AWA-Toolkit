import { GM, GM_xmlhttpRequest } from '$';
import type { SiteState } from './siteState';

const STEAM_FREE_CACHE_KEY = 'steamAppFreeCache';
/**
Permanently F2P (`is_free: true`) almost never changes.
*/
const STEAM_FREE_TTL_PERMANENT_MS = 7 * 24 * 60 * 60 * 1000;
/**
Paid / free-weekend price can change; recheck daily.
*/
const STEAM_FREE_TTL_PRICE_MS = 24 * 60 * 60 * 1000;
/**
Failed Steam lookups — don't retry on every AWA page load.
*/
const STEAM_FREE_TTL_ERROR_MS = 60 * 60 * 1000;
/**
Steam only reports a game to AWA after some playtime. ~6 min is often
enough; recommend 10 to be conservative.
*/
export const STEAM_LIBRARY_PLAY_MINUTES = 10;
export const STEAM_LIBRARY_PENDING_HINT = `Free on Steam — add it and play ~${String(STEAM_LIBRARY_PLAY_MINUTES)} min so it shows as owned`;

interface SteamFreeCacheEntry {
  isFree?: boolean;
  /**
  `is_free: true` from Steam — long TTL. Price-based $0 uses the short TTL.
  */
  permanent?: boolean;
  error?: boolean;
  at: string;
}

type SteamFreeCache = Record<string, SteamFreeCacheEntry>;

interface SteamAppDetailsData {
  is_free?: boolean;
  price_overview?: {
    final?: number;
    discount_percent?: number;
  };
}

interface SteamAppDetailsResponse {
  success?: boolean;
  data?: SteamAppDetailsData;
}

function parseSteamAppId(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return undefined;
  }
  return id;
}

/**
 * AWA quest pages use Steam CDN headers (`…/steam/apps/<id>/header.jpg`).
 * Community events expose `steam://run/<id>` when Launch Game is shown;
 * unowned pages typically use a store.steampowered.com/app/<id> link.
 */
export function scrapeSteamAppIdFromDocument(
  document_: Document,
): number | undefined {
  for (const image of document_.querySelectorAll('img')) {
    const fromSource = /\/steam\/apps\/(\d{2,10})\//.exec(image.src);
    const id = parseSteamAppId(fromSource?.[1]);
    if (id !== undefined) {
      return id;
    }
  }

  for (const link of document_.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') ?? '';
    const fromRun = /^steam:\/\/run\/(\d{2,10})/i.exec(href);
    const fromStore = /store\.steampowered\.com\/app\/(\d{2,10})/i.exec(href);
    const id = parseSteamAppId(fromRun?.[1] ?? fromStore?.[1]);
    if (id !== undefined) {
      return id;
    }
  }

  return undefined;
}

/**
 * Steam Store appdetails (`is_free`, else a $0 / 100% off `price_overview`).
 * Permanently F2P games set `is_free: true` and often omit price.
 * Free weekends stay `is_free: false` with a $0 / 100% off price.
 */
function steamFreeFromDetails(data: SteamAppDetailsData): {
  isFree: boolean;
  permanent: boolean;
} {
  if (data.is_free === true) {
    return { isFree: true, permanent: true };
  }
  const price = data.price_overview;
  const isFree = price?.final === 0 || (price?.discount_percent ?? 0) >= 100;
  return { isFree, permanent: false };
}

function cacheTtlMs(entry: SteamFreeCacheEntry): number {
  if (entry.error) {
    return STEAM_FREE_TTL_ERROR_MS;
  }
  if (entry.permanent) {
    return STEAM_FREE_TTL_PERMANENT_MS;
  }
  return STEAM_FREE_TTL_PRICE_MS;
}

function isCacheFresh(entry: SteamFreeCacheEntry | undefined): boolean {
  if (!entry) {
    return false;
  }
  const cachedAt = Date.parse(entry.at);
  if (!Number.isFinite(cachedAt)) {
    return false;
  }
  return Date.now() - cachedAt < cacheTtlMs(entry);
}

async function loadSteamFreeCache(): Promise<SteamFreeCache> {
  const raw: string | SteamFreeCache | undefined =
    await GM.getValue(STEAM_FREE_CACHE_KEY);
  if (!raw) {
    return {};
  }
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as SteamFreeCache;
    }
  } catch {
    return {};
  }
  return {};
}

async function saveSteamFreeCache(cache: SteamFreeCache): Promise<void> {
  await GM.setValue(STEAM_FREE_CACHE_KEY, JSON.stringify(cache));
}

const inflightLookup: {
  key?: string;
  promise?: Promise<Map<number, boolean | undefined>>;
} = {};

function fetchSteamAppDetailsBatch(
  appIds: number[],
): Promise<Record<string, SteamAppDetailsResponse> | undefined> {
  const ids = [...new Set(appIds)].toSorted((left, right) => left - right);
  if (ids.length === 0) {
    return Promise.resolve({});
  }
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://store.steampowered.com/api/appdetails?appids=${ids.join(',')}&cc=us`,
      anonymous: true,
      timeout: 8000,
      onload: (response) => {
        if (response.status < 200 || response.status >= 300) {
          resolve(undefined);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(response.responseText);
          if (typeof parsed !== 'object' || parsed === null) {
            resolve(undefined);
            return;
          }
          resolve(parsed as Record<string, SteamAppDetailsResponse>);
        } catch {
          resolve(undefined);
        }
      },
      onerror: () => {
        resolve(undefined);
      },
      ontimeout: () => {
        resolve(undefined);
      },
    });
  });
}

/**
 * At most one Steam store request per resolve, covering every unresolved app
 * ID. Fresh cache hits never hit the network.
 */
async function lookupSteamIsCurrentlyFreeMany(
  appIds: number[],
): Promise<Map<number, boolean | undefined>> {
  const unique = [...new Set(appIds)].toSorted((left, right) => left - right);
  const result = new Map<number, boolean | undefined>();
  if (unique.length === 0) {
    return result;
  }

  const inflightKey = unique.join(',');
  if (
    inflightLookup.key === inflightKey &&
    inflightLookup.promise !== undefined
  ) {
    return inflightLookup.promise;
  }

  const promise = lookupSteamIsCurrentlyFreeManyUncached(unique, result);
  inflightLookup.key = inflightKey;
  inflightLookup.promise = promise;
  try {
    return await promise;
  } finally {
    if (inflightLookup.key === inflightKey) {
      delete inflightLookup.key;
      delete inflightLookup.promise;
    }
  }
}

async function lookupSteamIsCurrentlyFreeManyUncached(
  unique: number[],
  result: Map<number, boolean | undefined>,
): Promise<Map<number, boolean | undefined>> {
  const cache = await loadSteamFreeCache();
  const missing: number[] = [];
  const nowIso = new Date().toISOString();

  for (const appId of unique) {
    const cached = cache[String(appId)];
    if (isCacheFresh(cached)) {
      result.set(appId, cached?.error ? undefined : cached?.isFree);
      continue;
    }
    missing.push(appId);
  }

  if (missing.length === 0) {
    return result;
  }

  const payload = await fetchSteamAppDetailsBatch(missing);
  for (const appId of missing) {
    const key = String(appId);
    const entry = payload?.[key];
    if (!entry?.success || !entry.data) {
      cache[key] = { error: true, at: nowIso };
      result.set(appId, undefined);
      continue;
    }
    const parsed = steamFreeFromDetails(entry.data);
    const stored: SteamFreeCacheEntry = {
      isFree: parsed.isFree,
      at: nowIso,
    };
    if (parsed.permanent) {
      stored.permanent = true;
    }
    cache[key] = stored;
    result.set(appId, parsed.isFree);
  }
  await saveSteamFreeCache(cache);
  return result;
}

type SteamFreeGate = {
  eligibility: 'eligible' | 'ineligible' | 'unknown';
  steamAppId?: number;
  isFree?: boolean;
  libraryPending?: boolean;
};

function requiresSteamFreeLookup(item: SteamFreeGate): boolean {
  return (
    item.eligibility === 'ineligible' &&
    item.steamAppId !== undefined &&
    item.isFree === undefined
  );
}

export function requiresSteamFreeHydrate(state: SiteState): boolean {
  const quests = state.steamQuests?.quests ?? [];
  if (quests.some((quest) => requiresSteamFreeLookup(quest))) {
    return true;
  }
  if (!state.communityEvent) {
    return false;
  }
  return requiresSteamFreeLookup(communityEventFreeGate(state.communityEvent));
}

function communityEventFreeGate(
  event: NonNullable<SiteState['communityEvent']>,
): SteamFreeGate {
  return {
    eligibility: event.playEligibility ?? 'unknown',
    ...(event.steamAppId !== undefined && { steamAppId: event.steamAppId }),
    ...(event.isFree !== undefined && { isFree: event.isFree }),
    ...(event.libraryPending === true && { libraryPending: true }),
  };
}

function applySteamFreeLookup<T extends SteamFreeGate>(
  item: T,
  isFree: boolean | undefined,
): T {
  if (isFree === true) {
    return {
      ...item,
      eligibility: 'eligible',
      isFree: true,
      libraryPending: true,
    };
  }
  if (isFree === false) {
    return { ...item, isFree: false };
  }
  return item;
}

/**
 * Check Game / Visit Steam means Steam has not reported the game to AWA yet
 * (needs some playtime). Keep recommending if Steam lists it as free or $0.
 * One batched store request for whatever is still unresolved.
 */
export async function resolveSiteStateSteamFreeToPlay(
  next: SiteState,
): Promise<void> {
  const quests = next.steamQuests?.quests ?? [];
  const event = next.communityEvent;
  const eventGate = event ? communityEventFreeGate(event) : undefined;
  const appIds: number[] = [];
  for (const quest of quests) {
    if (requiresSteamFreeLookup(quest) && quest.steamAppId !== undefined) {
      appIds.push(quest.steamAppId);
    }
  }
  if (
    eventGate &&
    requiresSteamFreeLookup(eventGate) &&
    eventGate.steamAppId !== undefined
  ) {
    appIds.push(eventGate.steamAppId);
  }
  if (appIds.length === 0) {
    return;
  }

  const freeByAppId = await lookupSteamIsCurrentlyFreeMany(appIds);
  if (quests.length > 0) {
    next.steamQuests = {
      scrapedAt: next.steamQuests?.scrapedAt ?? new Date().toISOString(),
      quests: quests.map((quest) => {
        if (!requiresSteamFreeLookup(quest) || quest.steamAppId === undefined) {
          return quest;
        }
        return applySteamFreeLookup(quest, freeByAppId.get(quest.steamAppId));
      }),
    };
  }

  if (
    !event ||
    !eventGate ||
    !requiresSteamFreeLookup(eventGate) ||
    eventGate.steamAppId === undefined
  ) {
    return;
  }
  const upgraded = applySteamFreeLookup(
    eventGate,
    freeByAppId.get(eventGate.steamAppId),
  );
  next.communityEvent = {
    ...event,
    playEligibility: upgraded.eligibility,
    ...(upgraded.steamAppId !== undefined && {
      steamAppId: upgraded.steamAppId,
    }),
    ...(upgraded.isFree !== undefined && { isFree: upgraded.isFree }),
    ...(upgraded.libraryPending === true && { libraryPending: true }),
  };
}
