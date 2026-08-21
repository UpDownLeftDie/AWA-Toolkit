import { BASE_ACTIVITY, lastDiscordPollPostAt } from '../data';
import type { ArpLogState } from './arpLog';
import { scrapeLiveCommunityEventBanner } from './communityEvent';
import {
  dailyQuestsCapFromRows,
  scrapeDailyQuestRowsFromDocument,
} from './dailyQuests';
import {
  findActivityCard,
  isElementVisiblyHidden,
  pageText,
  utcDateString,
} from './shared';
import {
  scrapeSteamQuestRowsFromDocument,
  steamQuestsCapFromRows,
} from './steamQuests';
import type { ActivityCapState, CapStatus, SiteState } from './types';

export interface WatchTwitchProgress {
  scrapedAt: string;
  /**
  Base Watch Twitch ARP earned today (`twitchData.totalPoints`).
  */
  baseArp: number;
  bonusArp: number;
  /**
  Raw `twitchData.timeWatched` from Control Center (minutes when it tracks
  1:1 with `totalPoints`).
  */
  timeWatched: number;
  isUnderCap: boolean;
  /**
  Unbuffed daily ARP cap from Quest Setup / terms ("up to N ARP every day").
  Watch-Twitch artifacts (Pn295 Alloy, etc.) raise the cap on top of this;
  rate stays 1 ARP/min so a higher cap means a longer sit.
  */
  capArp: number;
  /**
  Remaining watch at the unbuffed cap only. Prefer `twitchWatchRemainingMs`
  with the loadout's Watch Twitch flat.
  */
  remainingMs: number;
}

function readTimeOnSiteCap(body: string): CapStatus | undefined {
  const tosBlock =
    /Time on Site[\s\S]{0,200}?Max ARP per day:\s*(\d+)[\s\S]{0,80}?Earned ARP:\s*(\d+)/i.exec(
      body,
    );
  if (!tosBlock?.[1] || !tosBlock[2]) {
    return undefined;
  }
  const capArp = Number(tosBlock[1]);
  const earnedArp = Number(tosBlock[2]);
  if (!Number.isFinite(capArp) || !Number.isFinite(earnedArp)) {
    return undefined;
  }
  // UCF: equip ToS bonus before the unbuffed 5 ARP. Once that base is hit,
  // extra sit is inefficient — treat as done even if a ToS artifact raised max.
  if (earnedArp >= BASE_ACTIVITY.timeOnSiteBasePerDay) {
    return 'capped';
  }
  return earnedArp >= capArp ? 'capped' : 'available';
}

/**
CC status is `Incomplete: 0 ARP` (earned so far), not the bare word Incomplete.
*/
function parseTwitchArpStatus(document_: Document): {
  cap?: CapStatus;
  earnedArp?: number;
} {
  const status =
    document_
      .querySelector('#control-center__twitch-arp-status')
      ?.textContent?.trim() ?? '';
  const incompleteArp = /^Incomplete:\s*(\d+)\s*ARP/i.exec(status);
  if (incompleteArp?.[1] !== undefined) {
    return { cap: 'available', earnedArp: Number(incompleteArp[1]) };
  }
  if (/^Incomplete\b/i.test(status)) {
    return { cap: 'available' };
  }
  const completeArp = /^Complete:\s*(\d+)\s*ARP/i.exec(status);
  if (completeArp?.[1] !== undefined) {
    return { cap: 'capped', earnedArp: Number(completeArp[1]) };
  }
  if (/^Complete\b/i.test(status)) {
    return { cap: 'capped' };
  }
  return {};
}

function readWatchTwitchCapFromDocument(
  document_: Document,
): CapStatus | undefined {
  const fromStatus = parseTwitchArpStatus(document_).cap;
  if (fromStatus) {
    return fromStatus;
  }

  const card = findActivityCard(document_, /^Watch Twitch$/i);
  if (card && /Incomplete/i.test(card.textContent ?? '')) {
    return 'available';
  }

  const maxReached = document_.querySelector(
    '#control-center__twitch-max-reached',
  );
  if (
    maxReached &&
    !isElementVisiblyHidden(maxReached) &&
    /Max Cap Reached/i.test(maxReached.textContent ?? '')
  ) {
    return 'capped';
  }

  return readWatchTwitchCap(pageText(document_));
}

function readWatchTwitchCap(body: string): CapStatus | undefined {
  // Plain-text fallback when dedicated Twitch status nodes are missing.
  // Incomplete must win over a hidden "Max Cap Reached" in the same card.
  if (/Watch Twitch[\s\S]{0,400}?Incomplete:\s*\d+\s*ARP/i.test(body)) {
    return 'available';
  }
  if (/Watch Twitch[\s\S]{0,400}?\bIncomplete\b/i.test(body)) {
    return 'available';
  }
  if (
    /Watch Twitch[\s\S]{0,240}Max Cap Reached/i.test(body) &&
    !/twitch-max-reached[^>]*display:\s*none/i.test(body)
  ) {
    return 'capped';
  }
  if (/Watch Twitch[\s\S]{0,80}\bComplete\b/i.test(body)) {
    return 'capped';
  }
  return undefined;
}

/**
AWA credits 1 Watch Twitch ARP per minute (extension `/twitch/extensions/track`
poll, same cadence as Time on Site `/tos/track`).
*/
const TWITCH_MS_PER_ARP = 60_000;

interface DailyArpTwitchData {
  totalPoints: number;
  timeWatched: number;
  bonusPoints: number;
  isUnderCap: boolean;
}

function parseDailyArpTwitchData(
  document_: Document,
): DailyArpTwitchData | undefined {
  const scripts = [...document_.querySelectorAll('script:not([src])')]
    .map((script) => script.textContent ?? '')
    .join('\n');
  const assignment = /dailyArpData\s*=\s*(\{[\s\S]*?\});/.exec(scripts)?.[1];
  if (!assignment) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(assignment);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || !('twitchData' in parsed)) {
    return undefined;
  }
  const twitch = (parsed as { twitchData: unknown }).twitchData;
  if (!twitch || typeof twitch !== 'object') {
    return undefined;
  }
  const data = twitch as Record<string, unknown>;
  const totalPoints = Number(data.totalPoints);
  if (!Number.isFinite(totalPoints)) {
    return undefined;
  }
  const timeWatched = Number(data.timeWatched);
  const bonusPoints = Number(data.bonusPoints);
  return {
    totalPoints,
    timeWatched: Number.isFinite(timeWatched) ? timeWatched : 0,
    bonusPoints: Number.isFinite(bonusPoints) ? bonusPoints : 0,
    isUnderCap: isTwitchUnderCapFromData(data),
  };
}

function isTwitchUnderCapFromData(data: Record<string, unknown>): boolean {
  if (typeof data.underCap === 'boolean') {
    return data.underCap;
  }
  if (typeof data.isUnderCap === 'boolean') {
    return data.isUnderCap;
  }
  return true;
}

/**
Daily Twitch ARP cap from Quest Setup / Rewards terms / Control Center copy.
*/
function parseTwitchDailyCapArp(document_: Document): number | undefined {
  const body = pageText(document_);
  const patterns = [
    /only earn up to\s+(\d+)\s*ARP from Twitch/i,
    /Earn up to\s+(\d+)\s*ARP per day by watching participating Twitch/i,
    /watching Twitch[\s\S]{0,160}?earn up to\s+(\d+)\s*ARP every day/i,
    /Watch Twitch[\s\S]{0,240}?Max ARP per day:\s*(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (!match?.[1]) {
      continue;
    }
    const value = Number(match[1]);
    if (value > 0) {
      return value;
    }
  }
  return undefined;
}

/**
Merge Control Center `twitchData` + Quest Setup unbuffed daily cap.
Remaining watch for a loadout is `twitchWatchRemainingMs(state, twitchFlat)`.
*/
export function scrapeWatchTwitchProgressFromDocument(
  document_: Document,
  previous?: WatchTwitchProgress,
): WatchTwitchProgress | undefined {
  const twitchData = parseDailyArpTwitchData(document_);
  const capFromPage = parseTwitchDailyCapArp(document_);
  const status = parseTwitchArpStatus(document_);
  if (
    !twitchData &&
    capFromPage === undefined &&
    status.earnedArp === undefined &&
    status.cap === undefined
  ) {
    return previous;
  }
  const capArp =
    capFromPage ?? previous?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay;
  let isUnderCap: boolean;
  // Live Control Center status (Complete / Incomplete) wins over dailyArpData.
  // `underCap` is often missing, and the default-true path then treats a
  // Max Cap day as still watchable — which is how "Watch Twitch now" survives
  // on the same page that already says Complete.
  if (status.cap === 'capped') {
    isUnderCap = false;
  } else if (status.cap === 'available') {
    isUnderCap = true;
  } else if (twitchData) {
    isUnderCap = twitchData.isUnderCap;
  } else {
    isUnderCap = previous?.isUnderCap ?? true;
  }
  const parsedArp =
    status.earnedArp ?? twitchData?.totalPoints ?? previous?.baseArp ?? 0;
  const baseArp = isUnderCap ? parsedArp : Math.max(parsedArp, capArp);
  const remainingArp = isUnderCap ? Math.max(0, capArp - baseArp) : 0;
  return {
    scrapedAt: new Date().toISOString(),
    baseArp,
    bonusArp: twitchData?.bonusPoints ?? previous?.bonusArp ?? 0,
    timeWatched: twitchData?.timeWatched ?? previous?.timeWatched ?? 0,
    isUnderCap,
    capArp,
    remainingMs: remainingArp * TWITCH_MS_PER_ARP,
  };
}

/**
Wall-clock left to finish Watch Twitch at 1 ARP/min.
`twitchFlat` is the loadout's Pn295 / Scion bonus — it raises the daily cap,
not the tick rate, so Interstellar Pn295 is ~30m from zero (15+15).
*/
export function twitchWatchRemainingMs(
  state: SiteState | undefined,
  twitchFlat = 0,
  now = new Date(),
): number {
  const progress = state?.watchTwitch;
  const baseCap = progress?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay;
  const isFreshProgress =
    progress !== undefined &&
    utcDateString(new Date(progress.scrapedAt)) === utcDateString(now);
  // Max Cap Reached / Complete — today's twitch is done. A Pn295 on the
  // recommended loadout must not invent leftover ARP after the boosted cap
  // was already collected (Complete: 30 ARP with +15 still equipped).
  if (
    state?.caps.watchTwitch === 'capped' ||
    (isFreshProgress && progress && !progress.isUnderCap)
  ) {
    return 0;
  }
  // Watch Twitch resets at 00:00 UTC — ignore earn counts scraped yesterday.
  const earned = isFreshProgress && progress ? progress.baseArp : 0;
  return Math.max(0, baseCap + twitchFlat - earned) * TWITCH_MS_PER_ARP;
}

function readQuestStatusesFromCard(card: Element): CapStatus | undefined {
  const statuses = [...card.querySelectorAll('td, th, span, div, li')]
    .map((element) => element.textContent?.trim() ?? '')
    .filter((text) => /^(Incomplete|Complete)$/i.test(text));
  if (statuses.some((status) => /^Incomplete$/i.test(status))) {
    return 'available';
  }
  if (statuses.some((status) => /^Complete$/i.test(status))) {
    return 'capped';
  }
  const text = card.textContent ?? '';
  if (/Incomplete/i.test(text)) {
    return 'available';
  }
  if (/\bComplete\b/i.test(text)) {
    return 'capped';
  }
  return undefined;
}

function readSteamQuestsCap(body: string): CapStatus | undefined {
  // Avoid the broad "Daily" lookahead — it breaks section capture on Control Center.
  const steamSection =
    /Steam Quests([\s\S]{0,8000}?)(?=Watch Twitch|Discord Poll|Battle Pass|Time on Site|$)/i.exec(
      body,
    );
  if (!steamSection?.[1]) {
    return undefined;
  }
  const section = steamSection[1];
  if (/Incomplete/i.test(section)) {
    return 'available';
  }
  if (/\bComplete\b/i.test(section)) {
    return 'capped';
  }
  return undefined;
}

function readCapFromCardOrText(
  document_: Document,
  cardTitle: RegExp,
  textFallback: (body: string) => CapStatus | undefined,
): CapStatus | undefined {
  const card = findActivityCard(document_, cardTitle);
  if (card) {
    return readQuestStatusesFromCard(card) ?? textFallback(pageText(document_));
  }
  return textFallback(pageText(document_));
}

function readSteamQuestsCapFromDocument(
  document_: Document,
): CapStatus | undefined {
  const fromRows = steamQuestsCapFromRows(
    scrapeSteamQuestRowsFromDocument(document_),
  );
  if (fromRows) {
    return fromRows;
  }
  return readCapFromCardOrText(
    document_,
    /^Steam Quests$/i,
    readSteamQuestsCap,
  );
}

function readDailyQuestsCap(body: string): CapStatus | undefined {
  const section =
    /Daily Quests([\s\S]{0,1200}?)(?=Steam Quests|Watch Twitch|OLD SCHOOL|Community Event|$)/i.exec(
      body,
    );
  if (!section?.[1]) {
    return undefined;
  }
  if (/Incomplete/i.test(section[1])) {
    return 'available';
  }
  if (/\bComplete\b/i.test(section[1])) {
    return 'capped';
  }
  return undefined;
}

function readDailyQuestsCapFromDocument(
  document_: Document,
): CapStatus | undefined {
  const fromRows = dailyQuestsCapFromRows(
    scrapeDailyQuestRowsFromDocument(document_),
  );
  if (fromRows) {
    return fromRows;
  }
  return readCapFromCardOrText(
    document_,
    /^Daily Quests$/i,
    readDailyQuestsCap,
  );
}

function readDailyCalendarCap(body: string): CapStatus | undefined {
  // Legacy Control Center label.
  if (/Daily Login Calendar[\s\S]{0,120}Claimed/i.test(body)) {
    return 'capped';
  }
  if (/Daily Login Calendar[\s\S]{0,120}\bClaim\b/i.test(body)) {
    return 'available';
  }

  // Current Control Center: Today's Reward / 28-Day Daily Login Rewards.
  if (!/Today'?s Reward|28-Day Daily Login Rewards/i.test(body)) {
    return undefined;
  }
  if (/Today'?s Reward[\s\S]{0,240}Claimed/i.test(body)) {
    return 'capped';
  }
  if (/Today'?s Reward[\s\S]{0,240}\bClaim\b/i.test(body)) {
    return 'available';
  }
  // Calendar UI is present but there's no claim CTA → already taken today.
  return 'capped';
}

function readDailyCalendarCapFromDocument(
  document_: Document,
): CapStatus | undefined {
  const fromText = readDailyCalendarCap(pageText(document_));
  if (fromText) {
    return fromText;
  }
  const card = findActivityCard(
    document_,
    /^(Today'?s Reward|28-Day Daily Login Rewards|Daily Login)/i,
  );
  if (!card) {
    return undefined;
  }
  const claimControl = [...card.querySelectorAll('button, a')].find((element) =>
    /^claim$/i.test(element.textContent?.trim() ?? ''),
  );
  if (!claimControl) {
    return 'capped';
  }
  if (claimControl instanceof HTMLButtonElement && claimControl.disabled) {
    return 'capped';
  }
  if (claimControl.getAttribute('aria-disabled') === 'true') {
    return 'capped';
  }
  return 'available';
}

function isDiscordPollEntry(entry: { action: string }): boolean {
  return /Discord Poll/i.test(entry.action);
}

/**
 * ARP Log only stores a UTC date, not a time. Voting the previous weekday
 * poll after 00:00 UTC stamps today's date — and once today's poll posts at
 * 16:00 UTC that row looks like a vote for the new poll.
 *
 * Detect that carryover when the Discord Poll row sits on the day boundary
 * (newest-first: immediately older neighbor is a prior date, and nothing
 * older on the same date exists beneath it). A real same-day vote after the
 * post usually lands above other same-day earns, or the previous cycle
 * already has its own Discord Poll row.
 */
function isLatePreviousPollStamp(
  recent: ArpLogState['recent'],
  index: number,
  pollStartDate: string,
): boolean {
  const entry = recent[index];
  if (!entry || entry.date !== pollStartDate) {
    return false;
  }
  const older = recent[index + 1];
  if (!older?.date || older.date >= pollStartDate) {
    // Older neighbor is missing or same-day — not a day-boundary carryover.
    return false;
  }
  // Any same-day row below this one means the poll wasn't the first stamp of
  // the UTC day (vote happened after other same-day activity).
  for (let cursor = index + 1; cursor < recent.length; cursor += 1) {
    const row = recent[cursor];
    if (!row?.date) {
      continue;
    }
    if (row.date < pollStartDate) {
      break;
    }
    if (row.date === pollStartDate) {
      return false;
    }
  }
  return true;
}

function previousDiscordPollStartDate(pollStart: Date): string {
  const previousPost = lastDiscordPollPostAt(new Date(pollStart.getTime() - 1));
  return utcDateString(previousPost);
}

/**
 * Discord Poll only reposts on weekdays (`lastDiscordPollPostAt`), so a vote
 * cast Friday is still "this poll" through the whole weekend — check from
 * the last post date, not just today, or a Friday vote reads as still
 * pending all weekend.
 *
 * Same-calendar-day late votes for the *previous* poll are filtered via
 * {@link isLatePreviousPollStamp} and prior-cycle coverage so they don't
 * mark the newly posted poll as done.
 */
export function hasVotedCurrentDiscordPoll(
  arpLog: ArpLogState | undefined,
  now = new Date(),
): boolean {
  if (!arpLog || arpLog.recent.length === 0) {
    return false;
  }
  const pollStart = lastDiscordPollPostAt(now);
  const pollStartDate = utcDateString(pollStart);
  const previousPollStartDate = previousDiscordPollStartDate(pollStart);
  const recent = arpLog.recent;
  const hasVotedPreviousCycle = recent.some(
    (entry) =>
      isDiscordPollEntry(entry) &&
      entry.date !== undefined &&
      entry.date >= previousPollStartDate &&
      entry.date < pollStartDate,
  );

  return recent.some((entry, index) => {
    if (!isDiscordPollEntry(entry) || entry.date === undefined) {
      return false;
    }
    if (entry.date < pollStartDate) {
      return false;
    }
    if (entry.date > pollStartDate) {
      // Vote after midnight on a later UTC day, still before the next post.
      return true;
    }
    // entry.date === pollStartDate
    if (hasVotedPreviousCycle) {
      return true;
    }
    return !isLatePreviousPollStamp(recent, index, pollStartDate);
  });
}

/**
 * Mark activities complete when the ARP Log already shows the earn — for
 * Daily Login Calendar, Control Center renamed that UI often enough that the
 * log is the more reliable signal; for Discord Poll, Control Center never
 * surfaces it at all, so the log is the *only* signal.
 */
export function applyArpLogActivityCaps(
  caps: ActivityCapState,
  arpLog: ArpLogState | undefined,
  now = new Date(),
): ActivityCapState {
  if (!arpLog || arpLog.recent.length === 0) {
    return caps;
  }
  const today = utcDateString(now);
  const next: ActivityCapState = { ...caps };
  const todaysActions = arpLog.recent.filter((entry) => entry.date === today);

  if (
    todaysActions.some((entry) => /Daily Login Calendar/i.test(entry.action))
  ) {
    next.dailyCalendar = 'capped';
  }

  next.discordPoll = hasVotedCurrentDiscordPoll(arpLog, now)
    ? 'capped'
    : 'available';
  return next;
}

export function scrapeControlCenterCapsFromDocument(
  document_: Document,
): Partial<ActivityCapState> {
  const body = pageText(document_);
  const caps: Partial<ActivityCapState> = {};

  const timeOnSite = readTimeOnSiteCap(body);
  if (timeOnSite) {
    caps.timeOnSite = timeOnSite;
  }
  const watchTwitch = readWatchTwitchCapFromDocument(document_);
  if (watchTwitch) {
    caps.watchTwitch = watchTwitch;
  }
  const steamQuests = readSteamQuestsCapFromDocument(document_);
  if (steamQuests) {
    caps.steamQuests = steamQuests;
  }
  const dailyCalendar = readDailyCalendarCapFromDocument(document_);
  if (dailyCalendar) {
    caps.dailyCalendar = dailyCalendar;
  }
  const dailyQuests = readDailyQuestsCapFromDocument(document_);
  if (dailyQuests) {
    caps.dailyQuests = dailyQuests;
  }

  const liveEvent = scrapeLiveCommunityEventBanner(document_);
  caps.steamCommunityEvent = liveEvent ? 'available' : 'capped';

  return caps;
}

export function scrapeControlCenterCaps(): Partial<ActivityCapState> {
  return scrapeControlCenterCapsFromDocument(document);
}

const CONTROL_CENTER_WIDGET =
  '[id^="control-center__"], a.community-event-banner';

export function isControlCenterDocumentReady(document_: Document): boolean {
  return Boolean(document_.querySelector(CONTROL_CENTER_WIDGET));
}

/**
 * Twitch/ToS widgets exist in SSR empty; filled status text is the real paint.
 * `dailyArpData` is in the page immediately, so treating that as ready scrapes
 * before Complete/Incomplete exists and keeps a stale Watch Twitch step.
 * Remote HTML never hydrates — dailyArpData is all a fetch can see.
 */
export function isControlCenterTwitchDataReady(document_: Document): boolean {
  const status = document_
    .querySelector('#control-center__twitch-arp-status')
    ?.textContent?.trim();
  if (status) {
    return true;
  }
  if (document_ !== document) {
    return parseDailyArpTwitchData(document_) !== undefined;
  }
  return false;
}

export function isControlCenterActivityReady(document_: Document): boolean {
  return (
    isControlCenterDocumentReady(document_) &&
    isControlCenterTwitchDataReady(document_)
  );
}

export function controlCenterActivitySignature(document_: Document): string {
  const caps = scrapeControlCenterCapsFromDocument(document_);
  const twitch = scrapeWatchTwitchProgressFromDocument(document_);
  return [
    caps.watchTwitch,
    caps.steamQuests,
    caps.timeOnSite,
    caps.dailyCalendar,
    caps.dailyQuests,
    twitch?.baseArp,
    twitch?.isUnderCap,
    twitch?.timeWatched,
    twitch?.bonusArp,
  ].join(':');
}

export async function waitForControlCenterDocument(
  timeoutMs = 12_000,
): Promise<void> {
  if (isControlCenterActivityReady(document)) {
    return;
  }
  await new Promise<void>((resolve) => {
    let isSettled = false;
    const observer = new MutationObserver(() => {
      if (isControlCenterActivityReady(document)) {
        finish();
      }
    });
    const timer = setTimeout(finish, timeoutMs);
    function finish(): void {
      if (isSettled) {
        return;
      }
      isSettled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });
}
