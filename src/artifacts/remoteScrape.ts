import { nudgeStuckSlotLocks } from './api';
import { applyAsceCommunityHours } from './asce';
import { lastDiscordPollPostAt } from './data';
import {
  loadSnapshot,
  resolveShowroomUrl,
  saveSnapshot,
  scrapeShowroomFromDocument,
  type ArtifactSnapshot,
} from './scraper';
import { syncSlotLocksFromScrape } from './settings';
import {
  applyArpLogActivityCaps,
  applyBattlePassEndFromDocument,
  applyDailyQuestsFromDocument,
  applyGameVaultDocument,
  applyRedeemableArpFromDocument,
  applySteamFreeToPlayResolution,
  applySteamQuestsFromDocument,
  emptySiteState,
  isArpLogDocumentReady,
  isBattlePassDocumentReady,
  isChooseYourOwnGameQuest,
  isControlCenterActivityReady,
  isControlCenterDocumentReady,
  loadSiteState,
  markCommunityEventEnded,
  mergeArpLogScrape,
  mergeBattlePassScrape,
  mergeCommunityEventScrape,
  reconcileCommunityEventWithArpLog,
  requiresSteamQuestEligibilityFetch,
  saveSiteState,
  scrapeArpLogFromDocument,
  scrapeBattlePassFromDocument,
  scrapeCommunityEventFromDocument,
  scrapeControlCenterCapsFromDocument,
  scrapeLiveCommunityEventBanner,
  scrapeSteamPlayEligibilityFromDocument,
  scrapeUserArpTierFromDocument,
  scrapeWatchTwitchProgressFromDocument,
  steamQuestsCapFromRows,
  sumCommunityEventRewardsFromArpLog,
  utcDateString,
  waitForControlCenterDocument,
  type SiteState,
  type SteamQuestRow,
} from './siteState';
import { scrapeSteamAppIdFromDocument } from './steamApp';

/**
Inventory / activity caps refresh cadence.
*/
const STALE_MS = 6 * 60 * 60 * 1000;
/**
Showroom lock icons change when a 24h cooldown ends — recheck often so Control
Center is not stuck on a 6h-old "all locked" snapshot.
*/
const SLOT_LOCK_STALE_MS = 5 * 60 * 1000;
/**
ARP Log backs Discord Poll / calendar caps and event reward reconciliation.
A few hours is enough for background refresh; the Refresh button forces sooner
(see FORCE_REFRESH_COOLDOWN_MS).
*/
const ARP_LOG_STALE_MS = 6 * 60 * 60 * 1000;
/**
Ignore repeated Refresh clicks within this window per resource.
Showroom lock icons are cheap to re-check; keep this short so a second
Refresh after an unlock is not stuck on a stale snapshot.
*/
const FORCE_REFRESH_COOLDOWN_MS = 5 * 1000;
/**
Showroom HTML can lag a successful /change-user-artifacts POST. Retry once
before giving up and marking the snapshot stale for the post-reload hydrate.
*/
const EQUIP_CONFIRM_RETRY_MS = 750;
const BATTLE_PASS_STALE_MS = 60 * 60 * 1000;
/**
Live event page refresh for personal hours / awards. Community-hour rate
comes from ASCE (~hourly), so this can follow the normal 6h cadence.
*/
const COMMUNITY_EVENT_PENDING_STALE_MS = STALE_MS;
const CONTROL_CENTER_PATH = '/control-center';
const BATTLE_PASS_PATH = '/control-center/battle-pass/1';
const GAME_VAULT_PATH = '/marketplace/game-vault';
const ARP_LOG_PATH = '/account/arp-log';
const QUEST_SETUP_PATH = '/steam/questsetup';
/**
The site does not clamp `max` anywhere near this (confirmed up to several
thousand rows in one response), and the parser no longer stops early either —
so this only needs to be big enough for worst-case daily volume across
whichever window below is wider, with headroom.
*/
const ARP_LOG_MAX_ROWS = 300;
/**
No community event live: still explicit rather than relying on the site's own
default window, so it's guaranteed (not just observed) to reach back far
enough to cover the current Discord Poll — which, being weekday-only, is at
most ~3 days stale (Friday's post is still "current" through the weekend).
*/
const ARP_LOG_DEFAULT_DAYS = 7;
/**
Live event: reward reconciliation wants deeper history than the poll needs,
so this window already covers it too.
*/
const ARP_LOG_LIVE_EVENT_DAYS = 14;

/**
One ARP Log request serves every purpose that reads it — balance/history,
Daily Login Calendar, Discord Poll, and community-event reward reconciliation
— rather than each caller fetching its own scoped copy.
*/
function resolveArpLogPath(event: SiteState['communityEvent']): string {
  const days = event?.isLive ? ARP_LOG_LIVE_EVENT_DAYS : ARP_LOG_DEFAULT_DAYS;
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  // AWA's `to` is exclusive (page UI uses tomorrow to include today).
  const toExclusive = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return `${ARP_LOG_PATH}?from=${utcDateString(from)}&to=${utcDateString(toExclusive)}&max=${ARP_LOG_MAX_ROWS}`;
}

interface LoadedPage {
  document: Document;
  url: string;
}

function pathnameFromUrl(url: string, fallback: string): string {
  try {
    return new URL(url, location.origin).pathname;
  } catch {
    return fallback;
  }
}

async function fetchDocument(path: string): Promise<LoadedPage | undefined> {
  try {
    const response = await fetch(path, {
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) {
      console.warn(
        '[Artifact Optimizer] Failed to fetch',
        path,
        response.status,
      );
      return undefined;
    }
    const html = await response.text();
    return {
      document: new DOMParser().parseFromString(html, 'text/html'),
      url: response.url || path,
    };
  } catch (error) {
    console.warn('[Artifact Optimizer] Fetch error for', path, error);
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForCommunityEventHours(document_: Document): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const hours = document_
      .querySelector('#personal-hours')
      ?.textContent?.trim();
    if (hours) {
      break;
    }
    await delay(250);
  }
}

async function settleIframePage(
  iframe: HTMLIFrameElement,
  path: string,
): Promise<LoadedPage | undefined> {
  const document_ = iframe.contentDocument ?? undefined;
  if (!document_) {
    return undefined;
  }
  if (path.includes('/steam/community-event')) {
    await waitForCommunityEventHours(document_);
  } else if (path.includes('/battle-pass')) {
    await waitForBattlePassUi(document_);
  } else {
    await delay(400);
  }
  return {
    document: document_,
    url: iframe.contentWindow?.location.href ?? path,
  };
}

/**
 * Briefly open a same-origin page in a hidden iframe (fallback when fetch HTML
 * is incomplete), scrape, then remove it.
 */
async function openPageDocument(path: string): Promise<LoadedPage | undefined> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;width:1px;height:1px;left:-9999px;top:0;opacity:0;pointer-events:none;border:0';
    const cleanup = (): void => {
      iframe.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, 15_000);
    iframe.addEventListener('load', () => {
      clearTimeout(timer);
      void settleIframePage(iframe, path).then((page) => {
        cleanup();
        resolve(page);
      });
    });
    iframe.addEventListener('error', () => {
      clearTimeout(timer);
      cleanup();
      resolve(undefined);
    });
    document.body.append(iframe);
    iframe.src = path;
  });
}

async function waitForBattlePassUi(document_: Document): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (isBattlePassDocumentReady(document_)) {
      return;
    }
    await delay(250);
  }
}

function hasPersonalHours(document_: Document): boolean {
  const domHours = document_
    .querySelector('#personal-hours')
    ?.textContent?.trim();
  if (domHours && /\d/.test(domHours)) {
    return true;
  }
  if (/Your Total Hours:\s*[\d.]+/i.test(document_.body?.textContent ?? '')) {
    return true;
  }
  // Fetch HTML leaves #personal-hours empty; minutes are inlined as JS.
  const scripts = [...document_.querySelectorAll('script:not([src])')]
    .map((script) => script.textContent ?? '')
    .join('\n');
  return /personalPlaytime\s*=\s*\d+/i.test(scripts);
}

function requiresIframeFallback(path: string, fetched: Document): boolean {
  if (path.includes('/artifacts') || path.includes('/user-artifacts-room')) {
    return !fetched.body?.querySelector(
      ':scope a.artifact-list-item.change-artifact-modal, :scope .slot img',
    );
  }
  if (path.includes('/arp-log')) {
    return !isArpLogDocumentReady(fetched);
  }
  if (path.includes('/battle-pass')) {
    return !isBattlePassDocumentReady(fetched);
  }
  if (path.includes('/steam/community-event')) {
    // Hours are filled client-side into #personal-hours; fetch HTML is empty.
    return (
      !fetched.querySelector('.carousel-cell') || !hasPersonalHours(fetched)
    );
  }
  if (/\/steam\/quests\/.+/.test(path)) {
    return !hasSteamPlayEligibilitySignal(fetched);
  }
  return false;
}

function hasSteamPlayEligibilitySignal(document_: Document): boolean {
  if (
    document_.querySelector(
      ".btn-check-owned-games, .btn-start-quest, .alert-steam, a[href^='steam://']",
    )
  ) {
    return true;
  }
  const labels = [...document_.querySelectorAll('a, button')].map((element) =>
    (element.textContent ?? '').replaceAll(/\s+/g, ' ').trim(),
  );
  if (
    labels.some((label) =>
      /^(Check Game|Visit Steam|Sync Games|Launch Game)$/i.test(label),
    )
  ) {
    return true;
  }
  return /completed this quest/i.test(document_.body?.textContent ?? '');
}

async function loadRemotePage(path: string): Promise<LoadedPage | undefined> {
  const fetched = await fetchDocument(path);
  if (fetched?.document.querySelector('a.artifact-list-item, body')) {
    if (requiresIframeFallback(path, fetched.document)) {
      return openPageDocument(path);
    }
    return fetched;
  }
  return openPageDocument(path);
}

async function loadRemoteDocument(path: string): Promise<Document | undefined> {
  const loaded = await loadRemotePage(path);
  return loaded?.document;
}

function isSnapshotFresh(snapshot: ArtifactSnapshot | undefined): boolean {
  if (!snapshot || snapshot.artifacts.length === 0) {
    return false;
  }
  // Older snapshots lack lock data — force a Showroom refresh.
  if (!snapshot.slotLocks) {
    return false;
  }
  const scrapedAt = Date.parse(snapshot.scrapedAt);
  if (Number.isNaN(scrapedAt)) {
    return false;
  }
  return Date.now() - scrapedAt < STALE_MS;
}

function areSlotLocksFresh(snapshot: ArtifactSnapshot | undefined): boolean {
  if (!snapshot?.slotLocks) {
    return false;
  }
  return isScrapedWithin(snapshot.scrapedAt, SLOT_LOCK_STALE_MS);
}

function isCapsFresh(
  state: SiteState | undefined,
  now = new Date(),
): boolean {
  if (!state) {
    return false;
  }
  if (!isScrapedWithin(state.updatedAt, STALE_MS)) {
    return false;
  }
  // Twitch / calendar / dailies / time-on-site all reset at 00:00 UTC — a
  // scrape from before today can't reflect that.
  if (!isScrapedSinceUtcMidnight(state.updatedAt, now)) {
    return false;
  }
  const isCapsUnknown = Object.values(state.caps).every(
    (status) => status === 'unknown',
  );
  if (isCapsUnknown) {
    return false;
  }
  // Pre-1.4.22 state has no per-quest rows — rescan Control Center once.
  if (
    state.caps.steamQuests === 'available' &&
    (state.steamQuests?.quests.length ?? 0) === 0
  ) {
    return false;
  }
  return true;
}

/**
 * Battle Pass claims are JS-rendered. A fetch of the empty shell used to be
 * saved as 0 ready and then skipped for the whole caps TTL.
 */
function shouldRescrapeBattlePass(state: SiteState | undefined): boolean {
  const bp = state?.battlePass;
  if (!bp || typeof bp.readyToClaimArp !== 'number') {
    return true;
  }
  const scrapedAt = Date.parse(bp.scrapedAt ?? '');
  if (Number.isNaN(scrapedAt)) {
    return true;
  }
  return Date.now() - scrapedAt > BATTLE_PASS_STALE_MS;
}

async function refreshBattlePassOnly(next: SiteState): Promise<void> {
  const battleDocument = await loadRemoteDocument(BATTLE_PASS_PATH);
  if (!battleDocument) {
    return;
  }
  const battlePass = scrapeBattlePassFromDocument(battleDocument);
  if (battlePass) {
    next.battlePass = mergeBattlePassScrape(battlePass, next.battlePass);
  }
}

function isScrapedWithin(
  scrapedAt: string | undefined,
  maxAgeMs: number,
): boolean {
  if (!scrapedAt) {
    return false;
  }
  const at = Date.parse(scrapedAt);
  if (Number.isNaN(at)) {
    return false;
  }
  return Date.now() - at < maxAgeMs;
}

function utcDayStartMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Everything tied to a daily 00:00 UTC reset (activity caps, ARP-log-driven
 * claims, most Control Center widgets) is stale by definition if the last
 * scrape happened before today's UTC midnight — even when it is inside the
 * general TTL. Return false in that case so hydrate always covers the
 * current UTC day.
 */
function isScrapedSinceUtcMidnight(
  scrapedAt: string | undefined,
  now = new Date(),
): boolean {
  if (!scrapedAt) {
    return false;
  }
  const at = Date.parse(scrapedAt);
  if (Number.isNaN(at)) {
    return false;
  }
  return at >= utcDayStartMs(now);
}

/**
 * ARP Log is the only signal for Discord Poll votes and same-day Daily Login
 * Calendar claims, so any scrape from before the current UTC day — or before
 * the most recent weekday 16:00 UTC poll post — cannot see today's earn even
 * if it is within the general 6h TTL. Treat those as stale so a hydrate
 * always covers at least the current daily and poll cycles.
 *
 * An empty `recent` also counts as stale: an empty scrape can only mean "we
 * never actually saw the log" (a fresh page shell, an iframe that returned
 * before rows painted, a session miss) — never trust it to keep us from
 * refetching. `mergeArpLogScrape` stamps such scrapes with an epoch sentinel
 * so `isScrapedWithin` already fails, but check length explicitly in case a
 * future writer forgets that convention.
 */
function isArpLogFresh(
  state: SiteState | undefined,
  now = new Date(),
): boolean {
  const arpLog = state?.arpLog;
  if (!arpLog || arpLog.recent.length === 0) {
    return false;
  }
  const scrapedAt = arpLog.scrapedAt;
  if (!isScrapedWithin(scrapedAt, ARP_LOG_STALE_MS)) {
    return false;
  }
  if (!isScrapedSinceUtcMidnight(scrapedAt, now)) {
    return false;
  }
  const scrapedAtMs = Date.parse(scrapedAt);
  return scrapedAtMs >= lastDiscordPollPostAt(now).getTime();
}

function isCommunityEventFresh(
  state: SiteState | undefined,
  now = new Date(),
): boolean {
  const event = state?.communityEvent;
  if (!event?.isLive) {
    // No live event cached — refresh with Control Center cadence.
    return isCapsFresh(state, now);
  }
  // Banner-only cache (no carousel yet) — still need the event page.
  if (event.milestones.length === 0) {
    return false;
  }
  const ttl =
    event.pendingArp > 0 ? COMMUNITY_EVENT_PENDING_STALE_MS : STALE_MS;
  if (!isScrapedWithin(event.scrapedAt, ttl)) {
    return false;
  }
  // Personal community hours reset at 00:00 UTC — a scrape from before
  // today can't reflect today's playtime toward the next unlock.
  return isScrapedSinceUtcMidnight(event.scrapedAt, now);
}

async function persistShowroomSnapshot(
  loaded: LoadedPage,
  showroomPath: string,
  existing: ArtifactSnapshot | undefined,
): Promise<ArtifactSnapshot | undefined> {
  const snapshot = scrapeShowroomFromDocument(
    loaded.document,
    pathnameFromUrl(loaded.url, showroomPath),
  );
  if (snapshot.artifacts.length > 0) {
    await saveSnapshot(snapshot);
    await syncSlotLocksFromScrape(snapshot.slotLocks ?? {});
    console.info(
      '[Artifact Optimizer] Showroom locks',
      snapshot.slotLocks,
      'equipped',
      snapshot.artifacts
        .filter((artifact) => artifact.equippedPosition !== undefined)
        .map((artifact) => ({
          slot: artifact.equippedPosition,
          name: artifact.displayName,
          locked: artifact.slotLocked === true,
        })),
    );
    return snapshot;
  }
  if (existing?.slotLocks) {
    await syncSlotLocksFromScrape(existing.slotLocks);
  }
  return existing;
}

/**
 * Megumin FAQ: POST Upgrade on a maxed (0-frag) artifact clears AWA's stuck
 * 24h lock bug. Force Refresh does that, then re-fetches Showroom.
 */
async function scrapeShowroomAfterLockNudge(
  showroomPath: string,
  existing: ArtifactSnapshot | undefined,
): Promise<ArtifactSnapshot | undefined> {
  let inventory = existing;
  if (!inventory?.artifacts.length) {
    const prelim = await loadRemotePage(showroomPath);
    if (prelim) {
      inventory = scrapeShowroomFromDocument(
        prelim.document,
        pathnameFromUrl(prelim.url, showroomPath),
      );
    }
  }
  if (inventory?.artifacts.length) {
    await nudgeStuckSlotLocks(inventory.artifacts);
  }

  const loaded = await loadRemotePage(showroomPath);
  if (!loaded) {
    if (existing?.slotLocks) {
      await syncSlotLocksFromScrape(existing.slotLocks);
    }
    return existing;
  }
  return persistShowroomSnapshot(loaded, showroomPath, existing);
}

function hasSnapshotLoadout(
  snapshot: ArtifactSnapshot,
  applied: ReadonlyArray<{ artifactId: number; position: 1 | 2 | 3 }>,
): boolean {
  return applied.every((target) =>
    snapshot.artifacts.some(
      (artifact) =>
        artifact.instanceId === target.artifactId &&
        artifact.equippedPosition === target.position,
    ),
  );
}

async function fetchShowroomSnapshot(): Promise<ArtifactSnapshot | undefined> {
  const existing = await loadSnapshot();
  const showroomPath = resolveShowroomUrl(existing?.username);
  const loaded = await loadRemotePage(showroomPath);
  if (!loaded) {
    return;
  }
  const snapshot = scrapeShowroomFromDocument(
    loaded.document,
    pathnameFromUrl(loaded.url, showroomPath),
  );
  if (snapshot.artifacts.length === 0) {
    return;
  }
  return snapshot;
}

async function persistConfirmedShowroomSnapshot(
  snapshot: ArtifactSnapshot,
): Promise<void> {
  await saveSnapshot(snapshot);
  await syncSlotLocksFromScrape(snapshot.slotLocks ?? {});
}

async function invalidateSnapshotFreshness(): Promise<void> {
  const snapshot = await loadSnapshot();
  if (!snapshot) {
    return;
  }
  await saveSnapshot({
    ...snapshot,
    scrapedAt: new Date(0).toISOString(),
  });
}

function equippedSignature(snapshot: ArtifactSnapshot): string {
  const equipped = snapshot.artifacts
    .filter((artifact) => artifact.equippedPosition !== undefined)
    .map(
      (artifact) =>
        `${artifact.instanceId}:${artifact.equippedPosition}:${artifact.slotLocked === true ? '1' : '0'}`,
    )
    .toSorted((left, right) => left.localeCompare(right));
  const locks = ([1, 2, 3] as const)
    .map((position) => (snapshot.slotLocks?.[position] === true ? '1' : '0'))
    .join('');
  return `${equipped.join(',')}|${locks}`;
}

/**
 * Re-read Showroom after AWA rejects an equip. Persist whatever is actually
 * equipped/locked — the rejection means our cache was wrong.
 */
export async function resyncShowroomSnapshot(): Promise<{
  snapshot: ArtifactSnapshot | undefined;
  didChange: boolean;
}> {
  const previous = await loadSnapshot();
  const previousSig = previous ? equippedSignature(previous) : '';
  let snapshot = await fetchShowroomSnapshot();
  if (snapshot && equippedSignature(snapshot) === previousSig) {
    await delay(EQUIP_CONFIRM_RETRY_MS);
    snapshot = (await fetchShowroomSnapshot()) ?? snapshot;
  }
  if (!snapshot) {
    await invalidateSnapshotFreshness();
    return { snapshot: undefined, didChange: false };
  }
  const didChange = equippedSignature(snapshot) !== previousSig;
  if (didChange) {
    await persistConfirmedShowroomSnapshot(snapshot);
  } else {
    await invalidateSnapshotFreshness();
  }
  return { snapshot, didChange };
}

/**
 * Re-read Showroom after a successful equip and persist only when the new
 * pieces are actually in those slots. Does not invent equipped state.
 */
export async function confirmShowroomLoadout(
  applied: ReadonlyArray<{ artifactId: number; position: 1 | 2 | 3 }>,
): Promise<void> {
  if (applied.length === 0) {
    return;
  }

  const didConfirm = async (): Promise<boolean> => {
    const snapshot = await fetchShowroomSnapshot();
    if (!snapshot) {
      return false;
    }
    if (!hasSnapshotLoadout(snapshot, applied)) {
      return false;
    }
    await persistConfirmedShowroomSnapshot(snapshot);
    return true;
  };

  if (await didConfirm()) {
    return;
  }
  await delay(EQUIP_CONFIRM_RETRY_MS);
  if (await didConfirm()) {
    return;
  }
  await invalidateSnapshotFreshness();
}

export async function ensureArtifactSnapshot(
  options: { force?: boolean } = {},
): Promise<ArtifactSnapshot | undefined> {
  const existing = await loadSnapshot();
  const isWantsForce = options.force === true;

  // Refresh always re-fetches the Showroom — lock icons are cheap and are the
  // source of truth. Spam-guarding here left Control Center stuck on a stale
  // all-locked snapshot.
  if (
    !isWantsForce &&
    isSnapshotFresh(existing) &&
    areSlotLocksFresh(existing)
  ) {
    return existing;
  }

  const showroomPath = resolveShowroomUrl(existing?.username);
  if (isWantsForce) {
    return scrapeShowroomAfterLockNudge(showroomPath, existing);
  }

  const loaded = await loadRemotePage(showroomPath);
  if (!loaded) {
    if (existing?.slotLocks) {
      await syncSlotLocksFromScrape(existing.slotLocks);
    }
    return existing;
  }

  const snapshot = await persistShowroomSnapshot(
    loaded,
    showroomPath,
    existing,
  );
  if (snapshot) {
    return snapshot;
  }
  if (existing?.slotLocks) {
    await syncSlotLocksFromScrape(existing.slotLocks);
  }
  return existing;
}

function markCommunityEventUnavailable(next: SiteState): void {
  next.caps.steamCommunityEvent = 'capped';
  if (next.communityEvent) {
    next.communityEvent = markCommunityEventEnded(next.communityEvent);
  }
}

function cachedLiveCommunityEvent(
  next: SiteState,
  banner: { url: string; title?: string },
): NonNullable<SiteState['communityEvent']> {
  const previous = next.communityEvent;
  return {
    scrapedAt: new Date().toISOString(),
    url: banner.url,
    isLive: true,
    personalHours: previous?.personalHours ?? 0,
    milestones: previous?.milestones ?? [],
    pendingArp: previous?.pendingArp ?? 0,
    awardedArp: previous?.awardedArp ?? 0,
    ...(previous?.communityHours !== undefined && {
      communityHours: previous.communityHours,
    }),
    ...(previous?.communityHoursCap !== undefined && {
      communityHoursCap: previous.communityHoursCap,
    }),
    ...(previous?.communityHoursSamples && {
      communityHoursSamples: previous.communityHoursSamples,
    }),
    ...(previous?.communityHoursSource && {
      communityHoursSource: previous.communityHoursSource,
    }),
    ...(banner.title && { title: banner.title }),
    ...(previous?.playEligibility && {
      playEligibility: previous.playEligibility,
    }),
  };
}

async function refreshLiveCommunityEvent(
  next: SiteState,
  controlDocument?: Document,
): Promise<void> {
  const banner = controlDocument
    ? scrapeLiveCommunityEventBanner(controlDocument)
    : undefined;

  if (!banner) {
    if (
      controlDocument === document &&
      !isControlCenterDocumentReady(document)
    ) {
      return;
    }
    markCommunityEventUnavailable(next);
    return;
  }

  const eventDocument = await loadRemoteDocument(banner.url);
  if (!eventDocument) {
    next.caps.steamCommunityEvent = 'available';
    next.communityEvent = cachedLiveCommunityEvent(next, banner);
    return;
  }

  const scraped = scrapeCommunityEventFromDocument(eventDocument, banner.url);
  if (banner.title && !scraped.title) {
    // Banner text includes dates/LIVE noise — only use when page title missing.
    const cleaned = banner.title
      .replaceAll(/\bLIVE\b/gi, '')
      .replace(/Event:\s*[\d./\s-]+/i, '')
      .replaceAll(/\s+/g, ' ')
      .trim();
    if (cleaned) {
      scraped.title = cleaned;
    }
  }
  next.communityEvent = mergeCommunityEventScrape(
    scraped,
    next.communityEvent,
    { source: 'remote' },
  );
  next.caps.steamCommunityEvent = next.communityEvent.isLive
    ? 'available'
    : 'capped';
}

function applyWatchTwitchProgress(next: SiteState, document_: Document): void {
  const twitch = scrapeWatchTwitchProgressFromDocument(
    document_,
    next.watchTwitch,
  );
  if (twitch) {
    next.watchTwitch = twitch;
  }
}

function shouldFetchSteamQuestEligibility(quest: SteamQuestRow): boolean {
  return (
    quest.status !== 'complete' &&
    Boolean(quest.href) &&
    !isChooseYourOwnGameQuest(quest) &&
    quest.eligibility !== 'eligible' &&
    quest.isFree !== false
  );
}

async function enrichSteamQuestRow(
  quest: SteamQuestRow,
): Promise<SteamQuestRow> {
  if (!shouldFetchSteamQuestEligibility(quest) || !quest.href) {
    return quest;
  }
  const questDocument = await loadRemoteDocument(quest.href);
  if (!questDocument) {
    return quest;
  }
  const eligibility = scrapeSteamPlayEligibilityFromDocument(questDocument, {
    href: quest.href,
  });
  const steamAppId =
    scrapeSteamAppIdFromDocument(questDocument) ?? quest.steamAppId;
  const nextQuest: SteamQuestRow = { ...quest, eligibility };
  if (steamAppId !== undefined) {
    nextQuest.steamAppId = steamAppId;
  }
  return nextQuest;
}

async function enrichSteamQuestEligibility(next: SiteState): Promise<void> {
  const quests = next.steamQuests?.quests;
  if (!quests || quests.length === 0) {
    return;
  }
  const updated = await Promise.all(
    quests.map((quest) => enrichSteamQuestRow(quest)),
  );
  next.steamQuests = {
    scrapedAt: new Date().toISOString(),
    quests: updated,
  };
  const cap = steamQuestsCapFromRows(updated);
  if (cap) {
    next.caps.steamQuests = cap;
  }
}

function isLiveControlCenterPage(): boolean {
  let path = location.pathname;
  while (path.endsWith('/') && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path.endsWith('/control-center');
}

async function loadControlCenterDocument(): Promise<Document | undefined> {
  if (!isLiveControlCenterPage()) {
    return loadRemoteDocument(CONTROL_CENTER_PATH);
  }
  if (isControlCenterActivityReady(document)) {
    return document;
  }
  await waitForControlCenterDocument();
  if (isControlCenterDocumentReady(document)) {
    return document;
  }
  return loadRemoteDocument(CONTROL_CENTER_PATH);
}

function applyControlCenterDocument(
  next: SiteState,
  controlDocument: Document,
): void {
  const userArpTier = scrapeUserArpTierFromDocument(controlDocument);
  if (userArpTier !== undefined) {
    next.userArpTier = userArpTier;
  }
  applyRedeemableArpFromDocument(next, controlDocument);
  Object.assign(
    next.caps,
    scrapeControlCenterCapsFromDocument(controlDocument),
  );
  applySteamQuestsFromDocument(next, controlDocument);
  applyDailyQuestsFromDocument(next, controlDocument);
  applyWatchTwitchProgress(next, controlDocument);
  applyBattlePassEndFromDocument(next, controlDocument);
}

async function refreshActivityPages(next: SiteState): Promise<void> {
  const [controlDocument, questDocument, battleDocument, vaultDocument] =
    await Promise.all([
      loadControlCenterDocument(),
      loadRemoteDocument(QUEST_SETUP_PATH),
      loadRemoteDocument(BATTLE_PASS_PATH),
      loadRemoteDocument(GAME_VAULT_PATH),
    ]);

  if (controlDocument) {
    applyControlCenterDocument(next, controlDocument);
  }
  if (questDocument) {
    applyWatchTwitchProgress(next, questDocument);
  }
  if (battleDocument) {
    const battlePass = scrapeBattlePassFromDocument(battleDocument);
    if (battlePass) {
      next.battlePass = mergeBattlePassScrape(battlePass, next.battlePass);
    }
  }
  if (vaultDocument) {
    applyGameVaultDocument(next, vaultDocument);
  }

  await Promise.all([
    controlDocument
      ? refreshLiveCommunityEvent(next, controlDocument)
      : Promise.resolve(),
    enrichSteamQuestEligibility(next),
  ]);
}

function applyArpLogReconciliation(next: SiteState): void {
  next.caps = applyArpLogActivityCaps(next.caps, next.arpLog);
  if (!next.communityEvent) {
    return;
  }
  next.communityEvent = reconcileCommunityEventWithArpLog(
    next.communityEvent,
    next.arpLog,
  );
}

function reconcileCachedSiteState(existing: SiteState): SiteState {
  const next: SiteState = { ...existing, caps: { ...existing.caps } };
  applyArpLogReconciliation(next);
  return next;
}

async function refreshStaleLiveEvent(next: SiteState): Promise<void> {
  const event = next.communityEvent;
  if (!event?.isLive) {
    return;
  }
  const eventDocument = await loadRemoteDocument(event.url);
  if (!eventDocument) {
    return;
  }
  next.communityEvent = mergeCommunityEventScrape(
    scrapeCommunityEventFromDocument(eventDocument, event.url),
    event,
    { source: 'remote' },
  );
  next.caps.steamCommunityEvent = next.communityEvent.isLive
    ? 'available'
    : 'capped';
}

async function refreshArpLog(
  next: SiteState,
  existing: SiteState,
  options: { refreshLiveEventAfter: boolean },
): Promise<void> {
  const arpDocument = await loadRemoteDocument(
    resolveArpLogPath(next.communityEvent ?? existing.communityEvent),
  );
  if (arpDocument) {
    // Merge so a narrow scrape never drops a vote the previous window had.
    next.arpLog = mergeArpLogScrape(
      scrapeArpLogFromDocument(arpDocument),
      next.arpLog ?? existing.arpLog,
    );
  }
  // New log rewards often mean milestones just auto-awarded — refresh event.
  if (options.refreshLiveEventAfter && next.communityEvent?.isLive) {
    const eventDocument = await loadRemoteDocument(next.communityEvent.url);
    if (eventDocument) {
      next.communityEvent = mergeCommunityEventScrape(
        scrapeCommunityEventFromDocument(
          eventDocument,
          next.communityEvent.url,
        ),
        next.communityEvent,
        { source: 'remote' },
      );
    }
  }
}

export function requiresRemoteSnapshotHydrate(
  snapshot: ArtifactSnapshot | undefined,
): boolean {
  return !isSnapshotFresh(snapshot) || !areSlotLocksFresh(snapshot);
}

export function requiresRemoteSiteHydrate(
  state: SiteState | undefined,
  options: { force?: boolean } = {},
): boolean {
  if (!state || options.force) {
    return true;
  }
  return (
    !isCapsFresh(state) ||
    shouldRescrapeBattlePass(state) ||
    !isArpLogFresh(state) ||
    shouldRefreshCommunityEventArpLog(state) ||
    !isCommunityEventFresh(state) ||
    requiresSteamQuestEligibilityFetch(state)
  );
}

function shouldRefreshCommunityEventArpLog(state: SiteState): boolean {
  const event = state.communityEvent;
  if (!event?.isLive || event.pendingArp <= 0) {
    return false;
  }
  const received = sumCommunityEventRewardsFromArpLog(state.arpLog);
  // Open pending but no event rewards in the cached log → wrong/narrow scrape.
  if (received <= 0) {
    return true;
  }
  // Log is behind what the event page already marked awarded.
  return event.awardedArp > 0 && received < event.awardedArp;
}

export async function ensureSiteState(
  options: { force?: boolean } = {},
): Promise<SiteState> {
  const existing = (await loadSiteState()) ?? emptySiteState();
  const isForce = options.force === true;
  // Merge scrapes already keep ASCE hours / samples / play eligibility; force
  // just means "don't trust TTL". Short cooldown stops Refresh spam.
  const isForceCaps =
    isForce && !isScrapedWithin(existing.updatedAt, FORCE_REFRESH_COOLDOWN_MS);
  // Always re-pull ARP Log on Refresh — Discord Poll / calendar completion
  // only show up there, and a vote cast right after open must clear the step.
  const isForceArpLog = isForce;
  const isForceEvent =
    isForce &&
    !isScrapedWithin(
      existing.communityEvent?.scrapedAt,
      FORCE_REFRESH_COOLDOWN_MS,
    );

  const requiresCapsRefresh = isForceCaps || !isCapsFresh(existing);
  // Always re-pull Battle Pass on Refresh — claim buttons disappear after
  // claiming, and a fresh scrapedAt must not keep stale readyToClaimArp.
  const requiresBattlePassRefresh =
    isForce || requiresCapsRefresh || shouldRescrapeBattlePass(existing);
  const requiresArpLogRefresh =
    isForceArpLog ||
    !isArpLogFresh(existing) ||
    shouldRefreshCommunityEventArpLog(existing);
  const requiresEventRefresh = isForceEvent || !isCommunityEventFresh(existing);
  const requiresSteamEligibility =
    isForceCaps || requiresSteamQuestEligibilityFetch(existing);

  if (
    !requiresCapsRefresh &&
    !requiresBattlePassRefresh &&
    !requiresArpLogRefresh &&
    !requiresEventRefresh &&
    !requiresSteamEligibility
  ) {
    const next = reconcileCachedSiteState(existing);
    await applyAsceCommunityHours(next);
    await applySteamFreeToPlayResolution(next);
    await saveSiteState(next);
    return next;
  }

  const next: SiteState = {
    ...existing,
    updatedAt: new Date().toISOString(),
    caps: { ...existing.caps },
  };

  if (requiresCapsRefresh) {
    await refreshActivityPages(next);
  } else {
    if (requiresBattlePassRefresh) {
      await refreshBattlePassOnly(next);
    }
    if (requiresEventRefresh) {
      await refreshStaleLiveEvent(next);
    }
    if (requiresSteamEligibility) {
      await enrichSteamQuestEligibility(next);
    }
  }

  if (requiresArpLogRefresh) {
    await refreshArpLog(next, existing, {
      refreshLiveEventAfter: !requiresCapsRefresh && !requiresEventRefresh,
    });
  }

  applyArpLogReconciliation(next);
  await applySteamFreeToPlayResolution(next);
  await applyAsceCommunityHours(next);
  await saveSiteState(next);
  return next;
}
