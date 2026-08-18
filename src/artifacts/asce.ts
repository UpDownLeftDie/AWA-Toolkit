/**
 * ASCE (AWA community event data sync) — hourly community-hours history.
 * https://github.com/MarvashMagalli/ASCE
 *
 * Timestamps are when ASCE fetched AWA, not when AWA itself updated. Late
 * posts after :30 were often manual — treat clock times as approximate.
 * Slot-align to the reported `hour` so fetch jitter does not skew the rate.
 */
import { GM, GM_xmlhttpRequest } from '$';
import type { SiteState } from './siteState/types';
import {
  computePendingCommunityEventArp,
  type CommunityEventMilestoneGate,
  type CommunityEventState,
  type CommunityHoursSample,
  reconcileCommunityEventWithArpLog,
  upsertCommunityEventMilestoneGates,
  applyCommunityHoursUnlocks,
  applySequentialCommunityAwards,
} from './siteState/communityEvent';

const ASCE_CACHE_KEY = 'asceCommunityHours';
const ASCE_HOURS_URL =
  'https://raw.githubusercontent.com/MarvashMagalli/ASCE/main/stored_hours.json';
const ASCE_CONFIG_URL =
  'https://raw.githubusercontent.com/MarvashMagalli/ASCE/main/configAWA.json';
/**
 * ASCE updates about once an hour. Refresh mid-cycle so the next file is
 * picked up without hammering GitHub.
 */
const ASCE_CACHE_TTL_MS = 25 * 60 * 1000;
const ASCE_ERROR_TTL_MS = 30 * 60 * 1000;
const ASCE_SAMPLE_MAX = 96;
const FETCH_TIMEOUT_MS = 8000;

export interface AsceCommunityFeed {
  game: string;
  goalHours?: number;
  samples: CommunityHoursSample[];
  unlockedHours: number[];
  gates?: CommunityEventMilestoneGate[];
}

interface AsceCache {
  at: string;
  error?: boolean;
  feed?: AsceCommunityFeed;
}

const inflightLookup: {
  promise?: Promise<AsceCommunityFeed | undefined>;
} = {};

export function hasPendingAsceRefresh(): boolean {
  return inflightLookup.promise !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAsceCache(value: unknown): value is AsceCache {
  return isRecord(value) && typeof value.at === 'string';
}

function gmGetJson(url: string): Promise<unknown> {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      anonymous: true,
      timeout: FETCH_TIMEOUT_MS,
      onload: (response) => {
        if (response.status < 200 || response.status >= 300) {
          resolve(undefined);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(response.responseText);
          resolve(parsed);
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

async function loadAsceCache(): Promise<AsceCache> {
  const raw = await GM.getValue(ASCE_CACHE_KEY, '');
  if (typeof raw !== 'string' || raw.length === 0) {
    return { at: '' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isAsceCache(parsed)) {
      return { at: '' };
    }
    return parsed;
  } catch {
    return { at: '' };
  }
}

async function saveAsceCache(cache: AsceCache): Promise<void> {
  await GM.setValue(ASCE_CACHE_KEY, JSON.stringify(cache));
}

function cacheAgeMs(cache: AsceCache): number {
  const at = Date.parse(cache.at);
  if (Number.isNaN(at)) {
    return Number.POSITIVE_INFINITY;
  }
  return Date.now() - at;
}

function isCacheFresh(cache: AsceCache): boolean {
  if (!cache.at) {
    return false;
  }
  const ttl = cache.error ? ASCE_ERROR_TTL_MS : ASCE_CACHE_TTL_MS;
  return cacheAgeMs(cache) < ttl;
}

function communityEventSlug(url: string): string | undefined {
  try {
    const path = new URL(url, 'https://na.alienwarearena.com').pathname;
    const parts = path.split('/').filter(Boolean);
    const index = parts.indexOf('community-event');
    if (index === -1) {
      return undefined;
    }
    return parts[index + 1];
  } catch {
    return undefined;
  }
}

export function isAsceFeedForEvent(
  feed: AsceCommunityFeed,
  eventUrl: string,
): boolean {
  const slug = communityEventSlug(eventUrl);
  return slug !== undefined && slug === feed.game;
}

/**
 * Use the reported clock hour on that calendar day, not the fetch minute.
 * ASCE timestamps are scrape times; some late :30+ rows were manual.
 */
function asceSlotMs(timestamp: string, hour: number): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(
    timestamp,
  );
  if (!match || hour < 0 || hour > 23) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Date.UTC(year, month - 1, day, hour, 0, 0);
}

function parseAsceHourPoint(
  value: unknown,
): { slotMs: number; hours: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const hours = value.value;
  const hour = value.hour;
  const timestamp = value.timestamp;
  if (
    typeof hours !== 'number' ||
    typeof hour !== 'number' ||
    typeof timestamp !== 'string' ||
    !Number.isFinite(hours) ||
    hours < 0
  ) {
    return;
  }
  const slotMs = asceSlotMs(timestamp, hour);
  if (slotMs === undefined) {
    return undefined;
  }
  return { slotMs, hours };
}

function parseAsceHours(raw: unknown): CommunityHoursSample[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const bySlot = new Map<number, number>();
  for (const row of raw) {
    const parsed = parseAsceHourPoint(row);
    if (!parsed) {
      continue;
    }
    bySlot.set(parsed.slotMs, parsed.hours);
  }
  const slots = bySlot
    .keys()
    .toArray()
    .toSorted((left, right) => left - right);
  const samples: CommunityHoursSample[] = slots.map((slotMs) => ({
    at: new Date(slotMs).toISOString(),
    hours: bySlot.get(slotMs) ?? 0,
  }));
  if (samples.length > ASCE_SAMPLE_MAX) {
    return samples.slice(-ASCE_SAMPLE_MAX);
  }
  return samples;
}

function parseAsceArpReward(message: string): number {
  const arpAt = message.toUpperCase().indexOf(' ARP');
  if (arpAt === -1) {
    return 0;
  }
  const token = message.slice(0, arpAt).trim().split(' ').at(-1);
  const reward = Number(token);
  return Number.isFinite(reward) && reward > 0 ? reward : 0;
}

function byHoursAscending(
  left: { hours: number },
  right: { hours: number },
): number {
  return left.hours - right.hours;
}

function parseAsceGates(rows: unknown): CommunityEventMilestoneGate[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  const byHours = new Map<number, CommunityEventMilestoneGate>();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const hours = row.current_hours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
      continue;
    }
    const label =
      typeof row.milestone_message === 'string' &&
      row.milestone_message.trim().length > 0
        ? row.milestone_message.trim()
        : `${hours.toLocaleString()}h`;
    byHours.set(hours, {
      hours,
      arpReward: parseAsceArpReward(label),
      label,
      unlocked: row.unlocked === true,
    });
  }
  return byHours.values().toArray().toSorted(byHoursAscending);
}

function parseAsceConfig(raw: unknown): {
  game?: string;
  goalHours?: number;
  gates: CommunityEventMilestoneGate[];
  unlockedHours: number[];
} {
  if (!isRecord(raw)) {
    return { gates: [], unlockedHours: [] };
  }
  const game = typeof raw.game === 'string' ? raw.game : undefined;
  const goalHours =
    typeof raw.goal_hours === 'number' && Number.isFinite(raw.goal_hours)
      ? raw.goal_hours
      : undefined;
  const gates = [
    ...parseAsceGates(raw.milestones),
    ...parseAsceGates(raw.stretch_goals),
  ];
  const byHours = new Map(gates.map((gate) => [gate.hours, gate]));
  const uniqueGates = byHours.values().toArray().toSorted(byHoursAscending);
  return {
    ...(game && { game }),
    ...(goalHours !== undefined && { goalHours }),
    gates: uniqueGates,
    unlockedHours: uniqueGates
      .filter((gate) => gate.unlocked)
      .map((gate) => gate.hours),
  };
}

function requiresAsceGateRefresh(feed: AsceCommunityFeed | undefined): boolean {
  return feed !== undefined && feed.gates === undefined;
}

async function fetchAsceFeed(): Promise<AsceCommunityFeed | undefined> {
  const [hoursRaw, configRaw] = await Promise.all([
    gmGetJson(ASCE_HOURS_URL),
    gmGetJson(ASCE_CONFIG_URL),
  ]);
  const config = parseAsceConfig(configRaw);
  const samples = parseAsceHours(hoursRaw);
  if (!config.game || samples.length === 0) {
    return undefined;
  }
  return {
    game: config.game,
    samples,
    unlockedHours: config.unlockedHours,
    gates: config.gates,
    ...(config.goalHours !== undefined && { goalHours: config.goalHours }),
  };
}

export async function loadAsceCommunityFeed(
  options: { force?: boolean } = {},
): Promise<AsceCommunityFeed | undefined> {
  const cache = await loadAsceCache();
  if (
    !options.force &&
    isCacheFresh(cache) &&
    (cache.error || !requiresAsceGateRefresh(cache.feed))
  ) {
    if (cache.error) {
      return;
    }
    return cache.feed;
  }
  if (inflightLookup.promise !== undefined) {
    return inflightLookup.promise;
  }

  const promise = (async () => {
    const feed = await fetchAsceFeed();
    const at = new Date().toISOString();
    if (!feed) {
      await saveAsceCache({ at, error: true });
      return;
    }
    await saveAsceCache({ at, feed });
    return feed;
  })();
  inflightLookup.promise = promise;

  try {
    return await promise;
  } finally {
    delete inflightLookup.promise;
  }
}

function applyAsceUnlocks(
  milestones: CommunityEventState['milestones'],
  unlockedHours: number[],
): CommunityEventState['milestones'] {
  if (unlockedHours.length === 0) {
    return milestones;
  }
  const unlocked = new Set(unlockedHours);
  return milestones.map((milestone) => {
    if (milestone.isCommunityUnlocked) {
      return milestone;
    }
    const requiredHours = milestone.communityHoursRequired;
    if (requiredHours === undefined || !unlocked.has(requiredHours)) {
      return milestone;
    }
    return { ...milestone, isCommunityUnlocked: true };
  });
}

function resolveCommunityHours(
  scraped: number | undefined,
  asceHours: number | undefined,
): number | undefined {
  if (scraped === undefined) {
    return asceHours;
  }
  if (asceHours === undefined) {
    return scraped;
  }
  return Math.max(scraped, asceHours);
}

function withLiveHoursSample(
  samples: CommunityHoursSample[],
  event: CommunityEventState,
): CommunityHoursSample[] {
  if (event.communityHours === undefined) {
    return samples;
  }
  const last = samples.at(-1);
  if (!last || event.communityHours <= last.hours) {
    return samples;
  }
  return [
    ...samples,
    {
      at: event.scrapedAt,
      hours: event.communityHours,
    },
  ];
}

export function applyAsceFeedToEvent(
  event: CommunityEventState,
  feed: AsceCommunityFeed,
): CommunityEventState | undefined {
  if (!event.isLive || !isAsceFeedForEvent(feed, event.url)) {
    return;
  }

  const samples = withLiveHoursSample(feed.samples, event);
  if (samples.length === 0) {
    return;
  }

  const lastAsceHours = feed.samples.at(-1)?.hours;
  const communityHours = resolveCommunityHours(
    event.communityHours,
    lastAsceHours,
  );

  const withGates = upsertCommunityEventMilestoneGates(
    applyAsceUnlocks(event.milestones, feed.unlockedHours),
    feed.gates ?? [],
  );
  const unlocked = applyCommunityHoursUnlocks(withGates, communityHours);
  const milestones = applySequentialCommunityAwards(unlocked);
  const next: CommunityEventState = {
    ...event,
    milestones,
    pendingArp: computePendingCommunityEventArp(
      event.personalHours,
      milestones,
      communityHours,
    ),
    communityHoursSamples: samples,
    communityHoursSource: 'asce',
  };
  if (communityHours !== undefined) {
    next.communityHours = communityHours;
  }
  if (next.communityHoursCap === undefined && feed.goalHours !== undefined) {
    next.communityHoursCap = feed.goalHours;
  }
  return next;
}

function asceEventSignature(event: CommunityEventState): string {
  const last = event.communityHoursSamples?.at(-1);
  const waitingHours = event.milestones
    .filter((milestone) => !milestone.isAwarded && milestone.arpReward > 0)
    .map((milestone) => milestone.communityHoursRequired ?? 0)
    .join(',');
  return [
    event.communityHours ?? '',
    event.pendingArp,
    event.milestones.length,
    waitingHours,
    event.communityHoursSamples?.length ?? 0,
    last?.hours ?? '',
    last?.at ?? '',
  ].join('|');
}

function applyFeedIfLive(state: SiteState, feed: AsceCommunityFeed): void {
  const event = state.communityEvent;
  if (!event?.isLive) {
    return;
  }
  const next = applyAsceFeedToEvent(event, feed);
  if (!next) {
    return;
  }
  state.communityEvent = state.arpLog
    ? reconcileCommunityEventWithArpLog(next, state.arpLog)
    : next;
}

/**
 * Apply GM-cached ASCE if present (no GitHub wait). Starts a background
 * fetch when the cache is missing, stale, or from a build that dropped
 * stretch goals.
 */
export async function applyAsceCommunityHours(state: SiteState): Promise<void> {
  const event = state.communityEvent;
  if (!event?.isLive) {
    return;
  }
  const cache = await loadAsceCache();
  if (cache.feed && !cache.error) {
    applyFeedIfLive(state, cache.feed);
  }
  if (!isCacheFresh(cache)) {
    void loadAsceCommunityFeed();
    return;
  }
  if (cache.error || !requiresAsceGateRefresh(cache.feed)) {
    return;
  }
  const feed = await loadAsceCommunityFeed({ force: true });
  if (feed) {
    applyFeedIfLive(state, feed);
  }
}

/**
 * Await the in-flight / stale ASCE fetch and apply it. True when community
 * hours / ETA inputs changed from what was already on `state`.
 */
export async function didRefreshAsceCommunityHours(
  state: SiteState,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const event = state.communityEvent;
  if (!event?.isLive) {
    return false;
  }
  const before = asceEventSignature(event);
  const feed = await loadAsceCommunityFeed({ force: options.force === true });
  if (!feed) {
    return false;
  }
  applyFeedIfLive(state, feed);
  const next = state.communityEvent;
  if (!next) {
    return false;
  }
  return asceEventSignature(next) !== before;
}
