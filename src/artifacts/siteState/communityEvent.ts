import { scrapeSteamAppIdFromDocument } from '../steamApp';
import type { ArpLogState } from './arpLog';
import { pageText } from './shared';
import {
  scrapeSteamPlayEligibilityFromDocument,
  type SteamPlayEligibility,
} from './steamQuests';

export interface CommunityEventMilestone {
  index: number;
  personalHoursRequired: number;
  communityHoursRequired?: number;
  /**
	ARP granted by this milestone (0 for fragments/artifacts/cosmetics).
	*/
  arpReward: number;
  rewardLabel: string;
  /**
	Community hour gate has unlocked.
	ARP auto-awards once this AND personal hours are both met.
	*/
  isCommunityUnlocked: boolean;
  isAwarded: boolean;
}

export interface CommunityEventState {
  scrapedAt: string;
  url: string;
  title?: string;
  isLive: boolean;
  personalHours: number;
  /**
  Live community progress bar, e.g. 62160 of 100000 hour(s).
  */
  communityHours?: number;
  /**
  Denominator from the progress bar (usually the final milestone).
  */
  communityHoursCap?: number;
  /**
  Historical community-hour snapshots for unlock ETA (capped).
  Prefer ASCE hourly history when the feed matches this event.
  */
  communityHoursSamples?: CommunityHoursSample[];
  /**
  `asce` when samples came from https://github.com/MarvashMagalli/ASCE
  (do not keep appending per-visit points on top of that series).
  */
  communityHoursSource?: 'asce' | 'local';
  milestones: CommunityEventMilestone[];
  /**
	Unawarded ARP where at least one gate is already met (personal hours and/or
	community unlock). Rewards auto-grant once both gates are true.
	*/
  pendingArp: number;
  /**
	Sum of awarded milestone ARP bases from the event page (not All-ARP boosted).
	*/
  awardedArp: number;
  /**
	Sum of Steam Community Event Reward lines from ARP Log (actual ARP received).
	*/
  receivedArpFromLog?: number;
  /**
  You must own the event game on the linked Steam account. `ineligible` when
  the event page shows Check Game / Visit Steam / Sync Games and Steam says
  the title isn't free. Free games stay recommended — Steam only reports a
  newly added title to AWA after some playtime.
  */
  playEligibility?: SteamPlayEligibility;
  steamAppId?: number;
  isFree?: boolean;
  /**
  AWA didn't see the game in the library yet, but Steam lists it as free.
  */
  libraryPending?: boolean;
}

export function canEarnCommunityEventArp(
  event: CommunityEventState | undefined,
): boolean {
  return event?.playEligibility !== 'ineligible';
}

export interface CommunityHoursSample {
  at: string;
  hours: number;
}

/**
 * LIVE Steam Community Event banner on Control Center (href + title).
 */
export function scrapeLiveCommunityEventBanner(
  document_: Document,
): { url: string; title?: string } | undefined {
  const bannerLink =
    document_.querySelector<HTMLAnchorElement>(
      ':scope a.community-event-banner',
    ) ??
    document_.querySelector<HTMLAnchorElement>(
      ":scope .community-event-banner a[href*='/steam/community-event/']",
    ) ??
    [
      ...document_.querySelectorAll<HTMLAnchorElement>(
        ":scope a[href*='/steam/community-event/']",
      ),
    ].find((link) => /LIVE/i.test(link.textContent ?? ''));

  if (!bannerLink?.href) {
    return undefined;
  }
  const path = bannerLink.pathname || bannerLink.getAttribute('href') || '';
  if (!path.includes('/steam/community-event/')) {
    return undefined;
  }
  const title = bannerLink.textContent?.replaceAll(/\s+/g, ' ').trim();
  const result: { url: string; title?: string } = { url: path };
  if (title) {
    result.title = title;
  }
  return result;
}

/**
 * Community-hour gate is met from the page badge, ASCE unlock, or live hours
 * already at/past the requirement (stretch goals AWA hasn't badged yet).
 */
export function isCommunityGateMet(
  milestone: CommunityEventMilestone,
  communityHours: number | undefined,
): boolean {
  if (milestone.isCommunityUnlocked) {
    return true;
  }
  const required = milestone.communityHoursRequired;
  return (
    required !== undefined &&
    communityHours !== undefined &&
    communityHours >= required
  );
}

export function applyCommunityHoursUnlocks(
  milestones: CommunityEventMilestone[],
  communityHours: number | undefined,
): CommunityEventMilestone[] {
  if (communityHours === undefined) {
    return milestones;
  }
  return milestones.map((milestone) => {
    if (isCommunityGateMet(milestone, communityHours)) {
      return milestone.isCommunityUnlocked
        ? milestone
        : { ...milestone, isCommunityUnlocked: true };
    }
    return milestone;
  });
}

function milestoneSortKey(milestone: CommunityEventMilestone): number {
  return milestone.communityHoursRequired ?? milestone.index;
}

/**
 * Awards are sequential: if milestone N is awarded, every earlier gate is too.
 * A partial carousel scrape often only paints "Awarded" on the selected card.
 */
export function applySequentialCommunityAwards(
  milestones: CommunityEventMilestone[],
): CommunityEventMilestone[] {
  let lastAwardedKey = Number.NEGATIVE_INFINITY;
  for (const milestone of milestones) {
    if (!milestone.isAwarded) {
      continue;
    }
    const key = milestoneSortKey(milestone);
    if (key > lastAwardedKey) {
      lastAwardedKey = key;
    }
  }
  if (lastAwardedKey === Number.NEGATIVE_INFINITY) {
    return milestones;
  }
  return milestones.map((milestone) => {
    if (milestone.isAwarded || milestoneSortKey(milestone) >= lastAwardedKey) {
      return milestone;
    }
    return { ...milestone, isAwarded: true, isCommunityUnlocked: true };
  });
}

function personalHoursFromMilestones(
  milestones: CommunityEventMilestone[],
  scrapedHours: number,
): number {
  let hours = scrapedHours;
  for (const milestone of milestones) {
    if (
      milestone.isAwarded &&
      milestone.personalHoursRequired > hours
    ) {
      hours = milestone.personalHoursRequired;
    }
  }
  return hours;
}

export function isPersonalHoursMet(
  milestone: CommunityEventMilestone,
  personalHours: number,
): boolean {
  return milestone.personalHoursRequired <= personalHours;
}

/**
 * True when a milestone can still auto-award: not awarded yet, has ARP, and at
 * least one of the two gates is already satisfied. Award fires when both are.
 */
export function isCommunityEventMilestonePending(
  milestone: CommunityEventMilestone,
  personalHours: number,
  communityHours?: number,
): boolean {
  if (milestone.isAwarded || milestone.arpReward <= 0) {
    return false;
  }
  return (
    isPersonalHoursMet(milestone, personalHours) ||
    isCommunityGateMet(milestone, communityHours)
  );
}

export function computePendingCommunityEventArp(
  personalHours: number,
  milestones: CommunityEventMilestone[],
  communityHours?: number,
): number {
  return milestones
    .filter((milestone) =>
      isCommunityEventMilestonePending(
        milestone,
        personalHours,
        communityHours,
      ),
    )
    .reduce((sum, milestone) => sum + milestone.arpReward, 0);
}

export interface CommunityEventPendingBreakdown {
  /**
  Both gates are met and the event page / ARP log still do not mark it
  awarded. Not future earnable ARP — it should auto-grant, but it hasn't.
  */
  imminentArp: number;
  /**
  Personal hours met; still waiting on community unlock. Award fires when the
  community catches up (ETA from ASCE hourly history when available).
  */
  waitingCommunityArp: number;
  /**
  Community unlocked; personal hours not met yet. Player controls when this
  grants by playing more — equip All-ARP% before grinding those hours.
  */
  waitingPersonalArp: number;
  pendingCount: number;
}

/**
 * Split pending community-event ARP by which gate is still open.
 *
 * Scoring: `waitingPersonalArp` is player-controlled (play more hours after
 * community unlock). `waitingCommunityArp` is scored when ASCE ETA is inside
 * the 24h slot lock — you'll still be wearing that combo when it grants.
 * Unknown ETA stays unscored (UI warning only). `imminentArp` is unlocked
 * but not awarded yet.
 */
export function breakDownCommunityEventPending(
  event: CommunityEventState,
): CommunityEventPendingBreakdown {
  let imminentArp = 0;
  let waitingCommunityArp = 0;
  let waitingPersonalArp = 0;
  let pendingCount = 0;

  for (const milestone of event.milestones) {
    if (
      !isCommunityEventMilestonePending(
        milestone,
        event.personalHours,
        event.communityHours,
      )
    ) {
      continue;
    }
    pendingCount += 1;
    const isPersonalMet = isPersonalHoursMet(milestone, event.personalHours);
    if (isPersonalMet && isCommunityGateMet(milestone, event.communityHours)) {
      imminentArp += milestone.arpReward;
    } else if (isPersonalMet) {
      waitingCommunityArp += milestone.arpReward;
    } else {
      waitingPersonalArp += milestone.arpReward;
    }
  }

  return {
    imminentArp,
    waitingCommunityArp,
    waitingPersonalArp,
    pendingCount,
  };
}

/**
 * Milestone ARP is exact unless All-ARP% is equipped (then payout is boosted).
 */
export function formatCommunityEventArp(
  baseArp: number,
  allArpPct = 0,
): string {
  if (allArpPct > 0) {
    return `~${Math.round(baseArp * (1 + allArpPct))} ARP`;
  }
  return `${baseArp} ARP`;
}

function describeWaitingPersonalArp(
  event: CommunityEventState,
  waitingPersonalArp: number,
  allArpPct: number,
): string {
  const unmet = event.milestones.filter(
    (milestone) =>
      !milestone.isAwarded &&
      milestone.arpReward > 0 &&
      isCommunityGateMet(milestone, event.communityHours) &&
      !isPersonalHoursMet(milestone, event.personalHours),
  );
  let needHours = 0;
  for (const milestone of unmet) {
    if (milestone.personalHoursRequired > needHours) {
      needHours = milestone.personalHoursRequired;
    }
  }
  const moreHours = Math.max(0, needHours - event.personalHours);
  const head = formatCommunityEventArp(waitingPersonalArp, allArpPct);
  if (moreHours <= 0 || needHours <= 0) {
    return `${head} unlocked — not awarded yet`;
  }
  return `${head} unlocked — play ${moreHours}h more (${event.personalHours}h / ${needHours}h)`;
}

export function describeCommunityEventPending(
  event: CommunityEventState,
  allArpPct = 0,
): string {
  const { text, later } = describeCommunityEventPendingParts(event, allArpPct);
  if (!later) {
    return text;
  }
  return `${text} (${later})`;
}

export function describeCommunityEventPendingParts(
  event: CommunityEventState,
  allArpPct = 0,
): { text: string; later?: string } {
  const { imminentArp, waitingCommunityArp, waitingPersonalArp } =
    breakDownCommunityEventPending(event);
  const nextLocked = nextLockedCommunityArpMilestone(event);
  if (
    nextLocked === undefined &&
    imminentArp <= 0 &&
    waitingCommunityArp <= 0 &&
    waitingPersonalArp <= 0
  ) {
    return { text: 'no unawarded ARP remaining' };
  }

  const parts: string[] = [];
  let later: string | undefined;
  // Actionable first: community already unlocked — play hours with All-ARP%.
  if (waitingPersonalArp > 0) {
    parts.push(describeWaitingPersonalArp(event, waitingPersonalArp, allArpPct));
  }
  const lockedArp =
    waitingCommunityArp > 0 ? waitingCommunityArp : (nextLocked?.arpReward ?? 0);
  if (lockedArp > 0) {
    const waiting = describeWaitingCommunityArp(event, lockedArp, allArpPct);
    parts.push(waiting.text);
    later = waiting.later;
  }
  if (imminentArp > 0) {
    parts.push(
      `${formatCommunityEventArp(imminentArp, allArpPct)} unlocked — not awarded yet`,
    );
  }
  if (parts.length === 0) {
    return { text: 'no unawarded ARP remaining' };
  }
  return later ? { text: parts.join('; '), later } : { text: parts.join('; ') };
}

const COMMUNITY_SAMPLE_MAX = 96;
/**
Debounce rapid reloads when the user is on the event page.
*/
const COMMUNITY_SAMPLE_VISIT_MIN_GAP_MS = 15 * 60 * 1000;
/**
 * Local fallback only: remote scrapes add a rate sample on this cadence when
 * ASCE is unavailable. User visits still sample separately.
 */
export const COMMUNITY_HOURS_REMOTE_SAMPLE_MIN_MS = 60 * 60 * 1000;
const COMMUNITY_RATE_MIN_SPAN_MS = 15 * 60 * 1000;
const COMMUNITY_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMMUNITY_TREND_WINDOW_MS = 48 * 60 * 60 * 1000;
/**
 * Each half of the 48h window must be at least this long to trust a ratio.
 */
const COMMUNITY_TREND_HALF_MIN_MS = 18 * 60 * 60 * 1000;
const COMMUNITY_RATIO_MIN = 0.5;
const COMMUNITY_RATIO_MAX = 2;
/**
 * When the last two days are fading, only apply this fraction of the observed
 * decay. Shorter ETA = users swap artifacts before the gate, not after.
 * Growth is applied in full so a late push does not sneak up.
 */
const COMMUNITY_DECAY_TRUST = 0.5;
const COMMUNITY_RATIO_FLAT_EPS = 0.03;
/**
Ignore absurd rates (scrapes across events / bad data).
*/
const COMMUNITY_MAX_HOURS_PER_DAY = 80_000;

export type CommunityHoursSampleSource = 'visit' | 'remote';

/**
 * Drop live progress + sample history once an event ends (keeps awarded /
 * milestone snapshot for ARP-log reconciliation until the next event).
 */
export function markCommunityEventEnded(
  event: CommunityEventState,
): CommunityEventState {
  return {
    scrapedAt: event.scrapedAt,
    url: event.url,
    isLive: false,
    personalHours: event.personalHours,
    milestones: event.milestones,
    pendingArp: 0,
    awardedArp: event.awardedArp,
    ...(event.title !== undefined && { title: event.title }),
    ...(event.receivedArpFromLog !== undefined && {
      receivedArpFromLog: event.receivedArpFromLog,
    }),
  };
}

function shouldSkipCommunityHoursSample(options: {
  source: CommunityHoursSampleSource;
  gapMs: number;
  hours: number;
  lastHours: number;
}): boolean {
  const { source, gapMs, hours, lastHours } = options;
  if (source === 'remote') {
    // Remote: fixed minimum interval only.
    return gapMs < COMMUNITY_HOURS_REMOTE_SAMPLE_MIN_MS;
  }
  // Visit: skip unchanged duplicates within a short debounce.
  return gapMs < COMMUNITY_SAMPLE_VISIT_MIN_GAP_MS && hours === lastHours;
}

/**
 * Append a community-hours sample when progress moved or enough time passed.
 * Resets history if hours drop sharply (new event / bad scrape).
 */
export function appendCommunityHoursSample(
  samples: CommunityHoursSample[],
  hours: number,
  atIso = new Date().toISOString(),
  source: CommunityHoursSampleSource = 'visit',
): CommunityHoursSample[] {
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(hours) || hours < 0 || Number.isNaN(atMs)) {
    return samples;
  }

  const next = [...samples];
  const last = next.at(-1);
  if (last) {
    // New event or reset — start fresh.
    if (hours + 1 < last.hours) {
      return [{ at: atIso, hours }];
    }

    const lastMs = Date.parse(last.at);
    if (
      Number.isFinite(lastMs) &&
      shouldSkipCommunityHoursSample({
        source,
        gapMs: atMs - lastMs,
        hours,
        lastHours: last.hours,
      })
    ) {
      return next;
    }
  }

  next.push({ at: atIso, hours });
  if (next.length > COMMUNITY_SAMPLE_MAX) {
    return next.slice(-COMMUNITY_SAMPLE_MAX);
  }
  return next;
}

/**
 * Merge a fresh scrape with prior event state (keeps sample history while live).
 * Pass `source: 'visit'` for real page navigations; `'remote'` for background
 * fetches (samples only on the remote minimum interval).
 */
function isSparseCommunityEventScrape(
  scraped: CommunityEventState,
  previous: CommunityEventState | undefined,
): boolean {
  return (
    scraped.isLive &&
    previous?.isLive === true &&
    previous.milestones.length > 0 &&
    scraped.milestones.length === 0
  );
}

export function mergeCommunityEventScrape(
  scraped: CommunityEventState,
  previous: CommunityEventState | undefined,
  options: { source?: CommunityHoursSampleSource } = {},
): CommunityEventState {
  if (previous && isSparseCommunityEventScrape(scraped, previous)) {
    return previous;
  }
  return mergeLiveCommunityEventScrape(scraped, previous, options);
}

function mergeLiveCommunityEventScrape(
  scraped: CommunityEventState,
  previous: CommunityEventState | undefined,
  options: { source?: CommunityHoursSampleSource } = {},
): CommunityEventState {
  if (!scraped.isLive) {
    return markCommunityEventEnded(
      previous?.url === scraped.url
        ? { ...previous, ...scraped, isLive: false, pendingArp: 0 }
        : scraped,
    );
  }

  const source = options.source ?? 'visit';
  const sameEvent =
    previous &&
    (previous.url === scraped.url ||
      (previous.title !== undefined &&
        scraped.title !== undefined &&
        previous.title === scraped.title));

  const hasAsceHistory =
    Boolean(sameEvent) && previous?.communityHoursSource === 'asce';
  let samples = sameEvent ? [...(previous.communityHoursSamples ?? [])] : [];
  if (!hasAsceHistory && scraped.communityHours !== undefined) {
    samples = appendCommunityHoursSample(
      samples,
      scraped.communityHours,
      scraped.scrapedAt,
      source,
    );
  }

  const merged: CommunityEventState = {
    ...scraped,
  };
  if (samples.length > 0) {
    merged.communityHoursSamples = samples;
  }
  if (hasAsceHistory) {
    merged.communityHoursSource = 'asce';
  }
  return carryForwardCommunityEventFields(merged, previous, Boolean(sameEvent));
}

function milestoneMergeKey(milestone: CommunityEventMilestone): string {
  return milestone.communityHoursRequired === undefined
    ? `i:${milestone.index}`
    : `h:${milestone.communityHoursRequired}`;
}

/**
 * Visit/carousel scrapes win status flags, but must not wipe ARP or hour
 * gates we already know (ASCE stretch teasers often parse as 0 ARP).
 */
function preferCommunityEventMilestone(
  scraped: CommunityEventMilestone,
  previous: CommunityEventMilestone | undefined,
): CommunityEventMilestone {
  if (!previous) {
    return scraped;
  }
  const arpReward =
    scraped.arpReward > 0 ? scraped.arpReward : previous.arpReward;
  const next: CommunityEventMilestone = {
    ...previous,
    ...scraped,
    arpReward,
    // Complete ARP cells are source of truth after a visit; stubs keep prior.
    isAwarded:
      scraped.arpReward > 0 ? scraped.isAwarded : previous.isAwarded,
    isCommunityUnlocked:
      scraped.isCommunityUnlocked || previous.isCommunityUnlocked,
  };
  if (scraped.arpReward <= 0 && previous.arpReward > 0) {
    next.rewardLabel = previous.rewardLabel;
  }
  if (
    scraped.communityHoursRequired === undefined &&
    previous.communityHoursRequired !== undefined
  ) {
    next.communityHoursRequired = previous.communityHoursRequired;
  }
  if (
    scraped.personalHoursRequired <= 0 &&
    previous.personalHoursRequired > 0
  ) {
    next.personalHoursRequired = previous.personalHoursRequired;
  }
  return next;
}

/**
 * Union milestone lists so a partial carousel scrape cannot drop later
 * stretch gates we already know about (ASCE or an earlier full scrape).
 */
function mergeCommunityEventMilestones(
  scraped: CommunityEventMilestone[],
  previous: CommunityEventMilestone[] | undefined,
): CommunityEventMilestone[] {
  if (!previous || previous.length === 0) {
    return scraped;
  }
  const merged = new Map<string, CommunityEventMilestone>();
  const previousByIndex = new Map<number, CommunityEventMilestone>();
  for (const milestone of previous) {
    merged.set(milestoneMergeKey(milestone), milestone);
    previousByIndex.set(milestone.index, milestone);
  }
  for (const milestone of scraped) {
    const key = milestoneMergeKey(milestone);
    const previousMatch =
      merged.get(key) ??
      (milestone.communityHoursRequired === undefined
        ? previousByIndex.get(milestone.index)
        : undefined);
    if (previousMatch) {
      merged.delete(milestoneMergeKey(previousMatch));
    }
    const next = preferCommunityEventMilestone(milestone, previousMatch);
    merged.set(milestoneMergeKey(next), next);
  }
  return merged
    .values()
    .toArray()
    .toSorted(
      (left, right) =>
        (left.communityHoursRequired ?? left.index) -
        (right.communityHoursRequired ?? right.index),
    );
}

export interface CommunityEventMilestoneGate {
  hours: number;
  arpReward: number;
  label: string;
  unlocked: boolean;
}

function inferPersonalHoursRequired(
  existing: CommunityEventMilestone[],
): number {
  const known = existing
    .filter((milestone) => milestone.arpReward > 0)
    .map((milestone) => milestone.personalHoursRequired);
  if (known.length === 0) {
    return 1;
  }
  return Math.max(...known);
}

function splitMilestonesByHours(existing: CommunityEventMilestone[]): {
  byHours: Map<number, CommunityEventMilestone>;
  withoutHours: CommunityEventMilestone[];
} {
  const byHours = new Map<number, CommunityEventMilestone>();
  const withoutHours: CommunityEventMilestone[] = [];
  for (const milestone of existing) {
    const hours = milestone.communityHoursRequired;
    if (hours === undefined) {
      withoutHours.push(milestone);
    } else {
      byHours.set(hours, milestone);
    }
  }
  return { byHours, withoutHours };
}

function nextMilestoneIndex(existing: CommunityEventMilestone[]): number {
  let nextIndex = 1;
  for (const milestone of existing) {
    if (milestone.index >= nextIndex) {
      nextIndex = milestone.index + 1;
    }
  }
  return nextIndex;
}

function patchMilestoneFromGate(
  current: CommunityEventMilestone,
  gate: CommunityEventMilestoneGate,
): CommunityEventMilestone {
  const isUnlocking = gate.unlocked && !current.isCommunityUnlocked;
  const isFillingArp = current.arpReward <= 0 && gate.arpReward > 0;
  if (!isUnlocking && !isFillingArp) {
    return current;
  }
  return {
    ...current,
    ...(isUnlocking && { isCommunityUnlocked: true }),
    ...(isFillingArp && {
      arpReward: gate.arpReward,
      rewardLabel: gate.label,
    }),
  };
}

/**
 * Fill in community-hour gates the live page scrape missed (ASCE stretch
 * goals). Scraped rows win status flags; ASCE restores ARP and can flip
 * Community Unlocked when a teaser cell parsed as 0 ARP.
 */
export function upsertCommunityEventMilestoneGates(
  existing: CommunityEventMilestone[],
  gates: readonly CommunityEventMilestoneGate[],
): CommunityEventMilestone[] {
  if (gates.length === 0) {
    return existing;
  }
  const { byHours, withoutHours } = splitMilestonesByHours(existing);
  const inferredPersonal = inferPersonalHoursRequired(existing);
  let nextIndex = nextMilestoneIndex(existing);

  for (const gate of gates) {
    const current = byHours.get(gate.hours);
    if (current) {
      byHours.set(gate.hours, patchMilestoneFromGate(current, gate));
      continue;
    }
    byHours.set(gate.hours, {
      index: nextIndex,
      personalHoursRequired: inferredPersonal,
      communityHoursRequired: gate.hours,
      arpReward: gate.arpReward,
      rewardLabel: gate.label,
      isCommunityUnlocked: gate.unlocked,
      isAwarded: false,
    });
    nextIndex += 1;
  }

  return [...withoutHours, ...byHours.values()].toSorted(
    (left, right) =>
      (left.communityHoursRequired ?? left.index) -
      (right.communityHoursRequired ?? right.index),
  );
}

function carryForwardCommunityEventFields(
  merged: CommunityEventState,
  previous: CommunityEventState | undefined,
  isSameEvent: boolean,
): CommunityEventState {
  const next = { ...merged };
  if (
    previous &&
    isSameEvent &&
    merged.personalHours <= 0 &&
    previous.personalHours > 0
  ) {
    next.personalHours = previous.personalHours;
  }
  if (isSameEvent && previous) {
    next.milestones = applySequentialCommunityAwards(
      applyCommunityHoursUnlocks(
        mergeCommunityEventMilestones(next.milestones, previous.milestones),
        next.communityHours,
      ),
    );
    next.personalHours = personalHoursFromMilestones(
      next.milestones,
      next.personalHours,
    );
    next.pendingArp = computePendingCommunityEventArp(
      next.personalHours,
      next.milestones,
      next.communityHours,
    );
  }
  const shouldKeepPlayEligible =
    next.personalHours > 0 ||
    (isSameEvent &&
      previous?.playEligibility === 'eligible' &&
      merged.playEligibility !== 'ineligible');
  if (shouldKeepPlayEligible) {
    next.playEligibility = 'eligible';
  }
  if (
    isSameEvent &&
    previous?.communityHoursSource === 'asce' &&
    previous.communityHours !== undefined &&
    (next.communityHours === undefined ||
      next.communityHours < previous.communityHours)
  ) {
    next.communityHours = previous.communityHours;
    next.communityHoursSource = 'asce';
  }
  if (next.steamAppId === undefined && previous?.steamAppId !== undefined) {
    next.steamAppId = previous.steamAppId;
  }
  if (next.isFree === undefined && previous?.isFree !== undefined) {
    next.isFree = previous.isFree;
  }
  return next;
}

export interface CommunityUnlockEstimate {
  targetHours: number;
  hoursRemaining: number;
  hoursPerDay: number;
  etaMs: number;
  sampleCount: number;
}

/**
 * Unawarded community-hour ARP gates that are still locked, soonest first.
 * Unlike `waitingCommunityMilestones`, personal hours need not be met — this
 * is the next stretch goal to show even after a visit scrape.
 */
export function lockedCommunityArpMilestones(
  event: CommunityEventState,
): CommunityEventMilestone[] {
  return event.milestones
    .filter((milestone) => {
      if (milestone.isAwarded || milestone.arpReward <= 0) {
        return false;
      }
      if (milestone.communityHoursRequired === undefined) {
        return false;
      }
      return !isCommunityGateMet(milestone, event.communityHours);
    })
    .toSorted(
      (left, right) =>
        (left.communityHoursRequired ?? Number.POSITIVE_INFINITY) -
        (right.communityHoursRequired ?? Number.POSITIVE_INFINITY),
    );
}

export function nextLockedCommunityArpMilestone(
  event: CommunityEventState,
): CommunityEventMilestone | undefined {
  return lockedCommunityArpMilestones(event)[0];
}

/**
 * Community-hour ARP gates that still need community unlock
 * (personal hours already met), soonest first.
 */
export function waitingCommunityMilestones(
  event: CommunityEventState,
): CommunityEventMilestone[] {
  return lockedCommunityArpMilestones(event).filter((milestone) =>
    isPersonalHoursMet(milestone, event.personalHours),
  );
}

/**
 * Soonest community-hour ARP gate that still needs community unlock
 * (personal hours already met).
 */
export function nextWaitingCommunityMilestone(
  event: CommunityEventState,
): CommunityEventMilestone | undefined {
  return waitingCommunityMilestones(event)[0];
}

/**
 * Next community-hour gate for ARP still waiting on community unlock
 * (personal hours already met).
 */
export function nextCommunityUnlockTarget(
  event: CommunityEventState,
): number | undefined {
  return nextLockedCommunityArpMilestone(event)?.communityHoursRequired;
}

/**
 * Estimate time until the next waiting-on-community ARP milestone unlocks,
 * using ASCE hourly samples when present (local visit samples as fallback).
 *
 * Pace is the trailing 24h (not lifetime — launch day would make ETA too
 * early). A 48h day-over-day ratio adapts to fade vs a late push without
 * assuming a curve. Decay is half-trusted so the ETA stays on the early
 * side and users have time to swap artifacts.
 */
export function estimateCommunityUnlockAt(
  event: CommunityEventState,
  targetHours: number,
  nowMs = Date.now(),
): CommunityUnlockEstimate | undefined {
  const currentHours = event.communityHours;
  if (currentHours === undefined) {
    return undefined;
  }
  const hoursRemaining = targetHours - currentHours;
  if (hoursRemaining <= 0) {
    return {
      targetHours,
      hoursRemaining: 0,
      hoursPerDay: 0,
      etaMs: 0,
      sampleCount: event.communityHoursSamples?.length ?? 0,
    };
  }

  const samples = event.communityHoursSamples ?? [];
  const rate = estimateCommunityHoursPerMs(samples, nowMs);
  if (rate === undefined || rate <= 0) {
    return undefined;
  }

  const hoursPerDay = rate * 86_400_000;
  if (hoursPerDay > COMMUNITY_MAX_HOURS_PER_DAY) {
    return undefined;
  }

  const end = samples.at(-1);
  const measuredRatio = end
    ? communityDayOverDayRatio(samples, end)
    : undefined;
  const ratio =
    measuredRatio === undefined ? 1 : optimisticCommunityRatio(measuredRatio);

  return {
    targetHours,
    hoursRemaining,
    hoursPerDay,
    etaMs: communityEtaMs(hoursRemaining, rate, ratio),
    sampleCount: samples.length,
  };
}

export function estimateNextCommunityUnlock(
  event: CommunityEventState,
  nowMs = Date.now(),
): CommunityUnlockEstimate | undefined {
  const targetHours = nextCommunityUnlockTarget(event);
  if (targetHours === undefined) {
    return undefined;
  }
  return estimateCommunityUnlockAt(event, targetHours, nowMs);
}

export interface ReachableCommunityUnlock {
  targetHours: number;
  etaMs: number;
  arpReward: number;
}

/**
 * First waiting community ARP gate that grants after `readyAtMs` (when
 * All-ARP% can actually go on). Gates that fire before that are already a miss.
 */
export function nextReachableCommunityUnlock(
  event: CommunityEventState,
  readyAtMs: number,
  nowMs = Date.now(),
): ReachableCommunityUnlock | undefined {
  for (const milestone of waitingCommunityMilestones(event)) {
    const target = milestone.communityHoursRequired;
    if (target === undefined) {
      continue;
    }
    const eta = estimateCommunityUnlockAt(event, target, nowMs);
    if (eta === undefined || eta.etaMs < readyAtMs) {
      continue;
    }
    return {
      targetHours: target,
      etaMs: eta.etaMs,
      arpReward: milestone.arpReward,
    };
  }
  return undefined;
}

function parseCommunitySampleMs(
  sample: CommunityHoursSample,
): number | undefined {
  const ms = Date.parse(sample.at);
  return Number.isFinite(ms) ? ms : undefined;
}

function sampleAtOrBefore(
  samples: CommunityHoursSample[],
  tMs: number,
): CommunityHoursSample | undefined {
  let best: CommunityHoursSample | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    const ms = parseCommunitySampleMs(sample);
    if (ms !== undefined && ms <= tMs && ms >= bestMs) {
      best = sample;
      bestMs = ms;
    }
  }
  return best;
}

function communityHoursPerMsBetween(
  start: CommunityHoursSample,
  end: CommunityHoursSample,
): number | undefined {
  const startMs = parseCommunitySampleMs(start);
  const endMs = parseCommunitySampleMs(end);
  if (
    startMs === undefined ||
    endMs === undefined ||
    endMs - startMs < 2 * 60 * 1000
  ) {
    return undefined;
  }
  const deltaHours = end.hours - start.hours;
  if (deltaHours <= 0) {
    return undefined;
  }
  return deltaHours / (endMs - startMs);
}

/**
 * Trailing 24h when history is long enough; otherwise the full available
 * span (new events) or the last two points.
 */
function estimateCommunityHoursPerMs(
  samples: CommunityHoursSample[],
  nowMs: number,
): number | undefined {
  if (samples.length < 2) {
    return undefined;
  }

  const end = samples.at(-1);
  if (!end) {
    return undefined;
  }
  const endMs = parseCommunitySampleMs(end);
  if (endMs === undefined || nowMs - endMs > 3 * 86_400_000) {
    return undefined;
  }

  const windowStart = sampleAtOrBefore(
    samples,
    endMs - COMMUNITY_RATE_WINDOW_MS,
  );
  const fromWindow = windowStart
    ? communityHoursPerMsBetween(windowStart, end)
    : undefined;
  if (fromWindow !== undefined) {
    return fromWindow;
  }

  const first = samples.at(0);
  if (first && first !== end) {
    const fromHistory = communityHoursPerMsBetween(first, end);
    if (fromHistory !== undefined) {
      const startMs = parseCommunitySampleMs(first);
      if (
        startMs !== undefined &&
        endMs - startMs >= COMMUNITY_RATE_MIN_SPAN_MS
      ) {
        return fromHistory;
      }
    }
  }

  const previous = samples.at(-2);
  return previous ? communityHoursPerMsBetween(previous, end) : undefined;
}

function communityDayOverDayRatio(
  samples: CommunityHoursSample[],
  end: CommunityHoursSample,
): number | undefined {
  const endMs = parseCommunitySampleMs(end);
  if (endMs === undefined) {
    return undefined;
  }
  const mid = sampleAtOrBefore(samples, endMs - COMMUNITY_RATE_WINDOW_MS);
  const start = sampleAtOrBefore(samples, endMs - COMMUNITY_TREND_WINDOW_MS);
  if (!mid || !start || start === mid || mid === end) {
    return undefined;
  }
  const midMs = parseCommunitySampleMs(mid);
  const startMs = parseCommunitySampleMs(start);
  if (
    midMs === undefined ||
    startMs === undefined ||
    endMs - midMs < COMMUNITY_TREND_HALF_MIN_MS ||
    midMs - startMs < COMMUNITY_TREND_HALF_MIN_MS
  ) {
    return undefined;
  }
  const recent = communityHoursPerMsBetween(mid, end);
  const previous = communityHoursPerMsBetween(start, mid);
  if (recent === undefined || previous === undefined || previous <= 0) {
    return undefined;
  }
  const ratio = recent / previous;
  if (!Number.isFinite(ratio)) {
    return undefined;
  }
  return Math.min(COMMUNITY_RATIO_MAX, Math.max(COMMUNITY_RATIO_MIN, ratio));
}

function optimisticCommunityRatio(measured: number): number {
  if (measured >= 1) {
    return measured;
  }
  return 1 - (1 - measured) * COMMUNITY_DECAY_TRUST;
}

/**
 * Linear when the ratio is ~1. Otherwise integrate R0 * r^(t/day).
 * If fade is too steep to ever hit the target, fall back to linear so we
 * still warn early instead of implying "never".
 */
function communityEtaMs(
  remainingHours: number,
  ratePerMs: number,
  dailyRatio: number,
): number {
  const linearMs = remainingHours / ratePerMs;
  if (Math.abs(dailyRatio - 1) < COMMUNITY_RATIO_FLAT_EPS) {
    return linearMs;
  }
  const ratePerDay = ratePerMs * 86_400_000;
  const lnRatio = Math.log(dailyRatio);
  const root = 1 + (remainingHours * lnRatio) / ratePerDay;
  if (root <= 0) {
    return linearMs;
  }
  const days = Math.log(root) / lnRatio;
  if (!Number.isFinite(days) || days <= 0) {
    return linearMs;
  }
  return days * 86_400_000;
}

export function formatCommunityEta(etaMs: number): string {
  if (etaMs <= 0) {
    return 'now';
  }
  const totalMinutes = Math.round(etaMs / 60_000);
  if (totalMinutes < 60) {
    return `~${Math.max(1, totalMinutes)}m`;
  }
  const totalHours = Math.round(etaMs / 3_600_000);
  if (totalHours < 48) {
    return `~${totalHours}h`;
  }
  const days = totalHours / 24;
  return `~${days.toFixed(1)}d`;
}

/**
 * Compact community progress for unlock ETA, e.g. "65,184/75,000h · ETA ~18h".
 * Empty when we have nothing useful to show.
 */
export function describeWaitingCommunityProgress(
  event: CommunityEventState,
): string {
  const eta = estimateNextCommunityUnlock(event);
  const target = eta?.targetHours ?? nextCommunityUnlockTarget(event);
  const parts: string[] = [];

  if (target !== undefined && event.communityHours !== undefined) {
    parts.push(
      `${Math.round(event.communityHours).toLocaleString()}/${target.toLocaleString()}h`,
    );
  } else if (event.communityHours !== undefined) {
    parts.push(`${Math.round(event.communityHours).toLocaleString()}h`);
  }

  if (eta) {
    parts.push(`ETA ${formatCommunityEta(eta.etaMs)}`);
  }

  return parts.join(' · ');
}

export interface WaitingCommunityArpDescription {
  /**
   * Next unlock focus, e.g. "20 ARP · 73,701/75,000h · ETA ~3h".
   */
  text: string;
  /**
   * Later gated milestones, e.g. "+35 ARP later" — keep off the main line.
   */
  later?: string;
}

/**
 * Next unlock's ARP next to 72,521/75,000h progress. Remaining gated ARP
 * (later milestones) is returned separately so it isn't read as the
 * 75,000h reward.
 */
export function describeWaitingCommunityArp(
  event: CommunityEventState,
  waitingCommunityArp: number,
  allArpPct = 0,
): WaitingCommunityArpDescription {
  const locked = lockedCommunityArpMilestones(event);
  const next = locked[0];
  const progress = describeWaitingCommunityProgress(event);
  const nextArp = next?.arpReward ?? 0;
  const laterArp = locked
    .slice(1)
    .reduce((sum, milestone) => sum + milestone.arpReward, 0);
  const head = formatCommunityEventArp(
    nextArp > 0 ? nextArp : waitingCommunityArp,
    allArpPct,
  );
  const later =
    nextArp > 0 && laterArp > 0
      ? `+${formatCommunityEventArp(laterArp, allArpPct)} later`
      : undefined;
  const text = progress
    ? `${head} · ${progress}`
    : `${head} on community unlock`;
  return later ? { text, later } : { text };
}

/**
 * Compact single-line form (embeds later in parentheses when present).
 */
export function describeWaitingCommunityArpLine(
  event: CommunityEventState,
  waitingCommunityArp: number,
  allArpPct = 0,
): string {
  const { text, later } = describeWaitingCommunityArp(
    event,
    waitingCommunityArp,
    allArpPct,
  );
  return later ? `${text} (${later})` : text;
}

export function computeAwardedCommunityEventArp(
  milestones: CommunityEventMilestone[],
): number {
  return milestones
    .filter((milestone) => milestone.isAwarded && milestone.arpReward > 0)
    .reduce((sum, milestone) => sum + milestone.arpReward, 0);
}

export function isCommunityEventRewardAction(action: string): boolean {
  return /Steam Community Event Reward/i.test(action);
}

export function sumCommunityEventRewardsFromArpLog(
  arpLog: ArpLogState | undefined,
): number {
  if (!arpLog) {
    return 0;
  }
  return arpLog.recent
    .filter((entry) => isCommunityEventRewardAction(entry.action))
    .reduce((sum, entry) => sum + entry.arp, 0);
}

/**
 * Cross-check event-page award flags against ARP Log receipts.
 * Marks personal-met milestones as awarded when log ARP still accounts for
 * their base reward (handles stale scrapes / missing Community Unlocked flags).
 * Receipt in the log implies both gates were met at award time.
 */
export function reconcileCommunityEventWithArpLog(
  event: CommunityEventState,
  arpLog: ArpLogState | undefined,
): CommunityEventState {
  const receivedArpFromLog = sumCommunityEventRewardsFromArpLog(arpLog);
  const milestones = event.milestones
    .map((milestone) => ({
      ...milestone,
      isCommunityUnlocked: milestone.isCommunityUnlocked || milestone.isAwarded,
    }))
    .toSorted((left, right) => left.index - right.index);

  let remainingReceived = receivedArpFromLog;
  for (const milestone of milestones) {
    if (milestone.isAwarded && milestone.arpReward > 0) {
      remainingReceived = Math.max(0, remainingReceived - milestone.arpReward);
    }
  }

  for (const milestone of milestones) {
    if (
      milestone.isAwarded ||
      milestone.arpReward <= 0 ||
      !isPersonalHoursMet(milestone, event.personalHours) ||
      remainingReceived < milestone.arpReward
    ) {
      continue;
    }
    // Log receipt means the milestone already auto-awarded (both gates were met).
    milestone.isAwarded = true;
    milestone.isCommunityUnlocked = true;
    remainingReceived -= milestone.arpReward;
  }

  const nextMilestones = applySequentialCommunityAwards(milestones);
  const hours = personalHoursFromMilestones(
    nextMilestones,
    event.personalHours,
  );
  const next: CommunityEventState = {
    ...event,
    personalHours: hours,
    milestones: nextMilestones,
    pendingArp: computePendingCommunityEventArp(
      hours,
      nextMilestones,
      event.communityHours,
    ),
    awardedArp: computeAwardedCommunityEventArp(nextMilestones),
  };
  if (receivedArpFromLog > 0) {
    next.receivedArpFromLog = receivedArpFromLog;
  }
  return next;
}

function parseLabeledHours(text: string, label: string): number | undefined {
  const marker = `${label}: `;
  const start = text.indexOf(marker);
  if (start === -1) {
    return undefined;
  }
  const slice = text.slice(start + marker.length);
  const match = /^([\d.]+)/.exec(slice);
  return match?.[1] ? Number(match[1]) : undefined;
}

function parseLeadingCount(text: string, unit: string): number | undefined {
  const unitIndex = text.indexOf(` ${unit}`);
  if (unitIndex === -1) {
    return undefined;
  }
  const before = text.slice(0, unitIndex).trim();
  const token = before.split(' ').pop();
  const value = token ? Number(token) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
}

function isLabeledRowComplete(cell: Element, label: string): boolean {
  const needle = `${label}:`;
  const other = label === 'Personal' ? 'Community:' : 'Personal:';
  const row =
    [...cell.querySelectorAll('p, div, li, span, tr, td')].find((node) => {
      const text = node.textContent ?? '';
      return text.includes(needle) && !text.includes(other);
    }) ??
    [...cell.querySelectorAll('p, div, li, span, tr, td')].find((node) =>
      (node.textContent ?? '').includes(needle),
    );
  const scope = row ?? cell;
  if (scope.querySelector('.fa-check, .fa-check-circle, .bi-check, .bi-check-lg')) {
    return true;
  }
  return /[✓✔]/.test(scope.textContent ?? '');
}

function milestoneCellText(cell: Element): string {
  const parts = [cell.textContent ?? ''];
  const sibling = cell.nextElementSibling;
  if (sibling && !sibling.classList.contains('carousel-cell')) {
    parts.push(sibling.textContent ?? '');
  }
  return parts.join(' ').replaceAll(/\s+/g, ' ').trim();
}

function parseMilestoneCell(
  cell: Element,
): CommunityEventMilestone | undefined {
  const text = milestoneCellText(cell);
  const milestoneMarker = text.indexOf('Milestone ');
  if (milestoneMarker === -1) {
    return undefined;
  }
  const index = Number(
    text.slice(milestoneMarker + 'Milestone '.length).split(' ', 1)[0],
  );
  if (!Number.isFinite(index)) {
    return undefined;
  }

  const personalHoursRequired = parseLabeledHours(text, 'Personal') ?? 0;
  const communityHours = parseLabeledHours(text, 'Community');
  const arpReward = parseLeadingCount(text, 'ARP') ?? 0;
  const fragmentCount = parseLeadingCount(text, 'Fragment');
  const heading =
    cell.querySelector(':scope h3')?.textContent?.trim() ||
    cell.querySelector(':scope img[alt]')?.getAttribute('alt') ||
    (arpReward > 0 ? `${arpReward} ARP` : 'Reward');

  const milestone: CommunityEventMilestone = {
    index,
    personalHoursRequired,
    arpReward,
    rewardLabel: heading,
    isCommunityUnlocked:
      /Community Unlocked/i.test(text) ||
      isLabeledRowComplete(cell, 'Community'),
    isAwarded: /\bAwarded\b/i.test(text) && !/\bNot\s+Awarded\b/i.test(text),
  };
  if (communityHours !== undefined) {
    milestone.communityHoursRequired = communityHours;
  }
  if (fragmentCount !== undefined && arpReward <= 0) {
    milestone.rewardLabel = `${fragmentCount} Fragments`;
  }
  return milestone;
}

/**
 * Event pages fill `#personal-hours` client-side from an inline
 * `personalPlaytime` value (minutes). Static fetch HTML leaves the span empty,
 * so prefer DOM text when present, otherwise parse the script minutes.
 */
export function parseCommunityEventPersonalHours(document_: Document): number {
  const hoursFromDom = document_
    .querySelector('#personal-hours')
    ?.textContent?.trim();
  if (hoursFromDom && /\d/.test(hoursFromDom)) {
    const fromDom = Number(hoursFromDom);
    if (Number.isFinite(fromDom)) {
      return fromDom;
    }
  }

  const body = pageText(document_);
  const hoursFromText = /Your Total Hours:\s*([\d.]+)/i.exec(body)?.[1];
  if (hoursFromText) {
    const fromText = Number(hoursFromText);
    if (Number.isFinite(fromText)) {
      return fromText;
    }
  }

  // Server-rendered into page JS: `let personalPlaytime = 489;` (minutes).
  const scriptSource = [...document_.querySelectorAll('script:not([src])')]
    .map((script) => script.textContent ?? '')
    .join('\n');
  const minutesMatch =
    /personalPlaytime\s*=\s*(\d+)/i.exec(scriptSource) ??
    /personalPlaytime\s*=\s*(\d+)/i.exec(body);
  if (minutesMatch?.[1]) {
    return Math.floor(Number(minutesMatch[1]) / 60);
  }

  return 0;
}

function isAsciiWhitespace(char: string): boolean {
  return ' \t\n\r\f\v'.includes(char);
}

function trailingNumberToken(value: string): string | undefined {
  let end = value.length;
  while (end > 0 && isAsciiWhitespace(value[end - 1] ?? '')) {
    end -= 1;
  }
  let start = end;
  while (start > 0) {
    const char = value[start - 1] ?? '';
    if (char === ',' || (char >= '0' && char <= '9')) {
      start -= 1;
      continue;
    }
    break;
  }
  if (start === end) {
    return undefined;
  }
  return value.slice(start, end);
}

function leadingNumberToken(value: string): string | undefined {
  let start = 0;
  while (start < value.length && isAsciiWhitespace(value[start] ?? '')) {
    start += 1;
  }
  let end = start;
  while (end < value.length) {
    const char = value[end] ?? '';
    if (char === ',' || (char >= '0' && char <= '9')) {
      end += 1;
      continue;
    }
    break;
  }
  if (start === end) {
    return undefined;
  }
  return value.slice(start, end);
}

/**
 * Live progress bar text, e.g. "62160 of 100000 hour(s)".
 */
function parseHoursOfCap(text: string):
  | {
      hours: number;
      cap: number;
    }
  | undefined {
  const lower = text.toLowerCase();
  const hourIndex = lower.indexOf('hour');
  if (hourIndex === -1) {
    return undefined;
  }

  const beforeHour = text.slice(0, hourIndex);
  let leftRaw: string | undefined;
  let rightRaw: string | undefined;

  const ofIndex = beforeHour.toLowerCase().lastIndexOf(' of ');
  if (ofIndex === -1) {
    const slashIndex = beforeHour.lastIndexOf('/');
    if (slashIndex === -1) {
      return undefined;
    }
    leftRaw = beforeHour.slice(0, slashIndex);
    rightRaw = beforeHour.slice(slashIndex + 1);
  } else {
    leftRaw = beforeHour.slice(0, ofIndex);
    rightRaw = beforeHour.slice(ofIndex + 4);
  }

  const leftToken = trailingNumberToken(leftRaw);
  const rightToken = leadingNumberToken(rightRaw);
  if (!leftToken || !rightToken) {
    return undefined;
  }

  const hours = Number(leftToken.replaceAll(',', ''));
  const cap = Number(rightToken.replaceAll(',', ''));
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(cap) ||
    hours < 0 ||
    cap <= 0
  ) {
    return undefined;
  }

  return { hours, cap };
}

export function parseCommunityEventProgress(document_: Document): {
  communityHours?: number;
  communityHoursCap?: number;
} {
  const candidates = [
    ...document_.querySelectorAll('b, strong, .progress, .event-progress'),
  ].map((node) => node.textContent?.trim() ?? '');
  candidates.push(pageText(document_));

  for (const text of candidates) {
    const parsed = parseHoursOfCap(text);
    if (!parsed) {
      continue;
    }
    return {
      communityHours: parsed.hours,
      communityHoursCap: parsed.cap,
    };
  }
  return {};
}

function parseCommunityEventTitleFromDocumentTitle(
  documentTitle: string,
): string | undefined {
  const prefixMatch = /Steam Community Event\s*[-–]\s*/i.exec(documentTitle);
  if (!prefixMatch) {
    return undefined;
  }

  let title = documentTitle
    .slice(prefixMatch.index + prefixMatch[0].length)
    .trim();
  const pipeIndex = title.lastIndexOf('|');
  if (pipeIndex !== -1) {
    const suffix = title.slice(pipeIndex + 1).trim();
    if (suffix.toLowerCase() === 'alienware arena') {
      title = title.slice(0, pipeIndex).trim();
    }
  }

  return title.length > 0 ? title : undefined;
}

function parseCommunityEventTitle(document_: Document): string | undefined {
  const documentTitle = document_.title?.replaceAll(/\s+/g, ' ').trim() ?? '';
  const fromDocumentTitle =
    parseCommunityEventTitleFromDocumentTitle(documentTitle);
  if (fromDocumentTitle) {
    return fromDocumentTitle;
  }

  const fromEventLabel = document_
    .querySelector(
      '.event-title-date, :scope .community-event-view .event-name',
    )
    ?.textContent?.replaceAll(/\s+/g, ' ')
    .trim();
  if (fromEventLabel && !isCommunityEventLiveDateBar(fromEventLabel)) {
    return fromEventLabel;
  }

  return undefined;
}

function isCommunityEventLiveDateBar(text: string): boolean {
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  if (!/\bLIVE\b/i.test(normalized)) {
    return false;
  }
  return (
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(
      normalized,
    ) || /\bLIVE\s*\|/i.test(normalized)
  );
}

/**
 * Live vs ended on the event page. AWA paints `LIVE | Aug 7, 2026 - … | LIVE`
 * in `.event-title-date` — that is the badge. `.live-container .live-text` is
 * an older/alternate chrome. `.event-closed` is the only end signal.
 */
function readCommunityEventLiveBadge(document_: Document): boolean | undefined {
  if (document_.querySelector('.event-closed')) {
    return false;
  }
  if (document_.querySelector('.live-text')) {
    return true;
  }
  const dateBar = document_.querySelector(
    '.event-title-date, .live-container',
  );
  const dateBarText = dateBar?.textContent?.replaceAll(/\s+/g, ' ').trim() ?? '';
  if (isCommunityEventLiveDateBar(dateBarText)) {
    return true;
  }
  return undefined;
}

/**
 * Parse a LIVE Steam Community Event page (carousel milestone cards).
 * Pending ARP = not yet awarded, and personal hours and/or community unlock
 * already met (auto-awards when both gates are true).
 */
export function scrapeCommunityEventFromDocument(
  document_: Document,
  url: string,
): CommunityEventState {
  const personalHours = parseCommunityEventPersonalHours(document_);
  // `.event-closed` ends it. The LIVE date bar (and `.live-text`) keep it live.
  // Unknown still stays live so a visit cannot drop stretch-goal todos.
  const isLive = readCommunityEventLiveBadge(document_) !== false;

  const milestones: CommunityEventMilestone[] = [];
  let personalHoursFloor = Number.isFinite(personalHours) ? personalHours : 0;
  for (const cell of document_.querySelectorAll('.carousel-cell')) {
    const milestone = parseMilestoneCell(cell);
    if (!milestone) {
      continue;
    }
    milestones.push(milestone);
    if (
      isLabeledRowComplete(cell, 'Personal') &&
      milestone.personalHoursRequired > personalHoursFloor
    ) {
      personalHoursFloor = milestone.personalHoursRequired;
    }
  }

  milestones.sort((left, right) => left.index - right.index);
  const awardedMilestones = applySequentialCommunityAwards(milestones);
  const safeHours = personalHoursFromMilestones(
    awardedMilestones,
    personalHoursFloor,
  );
  const titleMatch = parseCommunityEventTitle(document_);
  const progress = parseCommunityEventProgress(document_);
  const playEligibility = scrapeSteamPlayEligibilityFromDocument(document_, {
    personalHours: safeHours,
  });
  const steamAppId = scrapeSteamAppIdFromDocument(document_);
  const state: CommunityEventState = {
    scrapedAt: new Date().toISOString(),
    url,
    isLive,
    personalHours: safeHours,
    milestones: awardedMilestones,
    pendingArp: computePendingCommunityEventArp(
      safeHours,
      awardedMilestones,
      progress.communityHours,
    ),
    awardedArp: computeAwardedCommunityEventArp(awardedMilestones),
    playEligibility,
  };
  if (steamAppId !== undefined) {
    state.steamAppId = steamAppId;
  }
  if (titleMatch) {
    state.title = titleMatch;
  }
  if (progress.communityHours !== undefined) {
    state.communityHours = progress.communityHours;
  }
  if (progress.communityHoursCap !== undefined) {
    state.communityHoursCap = progress.communityHoursCap;
  }
  return state;
}

export function scrapeCommunityEvent(): CommunityEventState | undefined {
  if (!location.pathname.includes('/steam/community-event')) {
    return undefined;
  }
  return scrapeCommunityEventFromDocument(document, location.pathname);
}
