import {
  BASE_ACTIVITY,
  msUntilNextDiscordPollPost,
} from '../data';
import { MS_PER_DAY, MS_PER_MINUTE } from '../../core/time';
import {
  type ActivityLoadoutStats,
  activityStatsForArtifacts,
  canCompleteInWearWindow,
  msUntilNextSteamQuestWeek,
  type OptimizerResult,
} from '../optimizer';
import type { ArtifactOptimizerSettings } from '../settings';
import {
  utcDailyEndBufferMs,
} from '../settings';
import {
  type ActivityKey,
  breakDownCommunityEventPending,
  canEarnCommunityEventArp,
  describeCommunityEventPendingParts,
  estimateNextCommunityUnlock,
  isActivityAvailable,
  isActivityPending,
  isCommunityGateMet,
  isPersonalHoursMet,
  nextLockedCommunityArpMilestone,
  remainingDailyQuestRows,
  remainingSteamQuestRewards,
  remainingSteamQuestRows,
  type SiteState,
  twitchWatchRemainingMs,
} from '../siteState';
import { STEAM_LIBRARY_PENDING_HINT } from '../steamApp';
import {
  artifactsAfterImmediateEquip,
  planLoadoutChanges,
} from '../optimizer/swapPlan';
import {
  formatMs,
  msUntilUtcMidnight,
  utcResetDeadlineLabel,
} from '../loadoutFormat';
import type {
  ActionTodo,
  ActionTodoChain,
  ActionTodoReason,
  ActionTodoUrgency,
} from './types';
import {
  actionUrgency,
  type ActivityPhase,
  activityWindowArp,
  bonusForActivityPhase,
  comboBonusForActivity,
  type LoadoutLike,
  type PlannedWear,
  plannedWearForResets,
} from './shared';

// ── Activity types / constants ─────────────────────────────────────────

interface ActivityTodoRule {
  key: ActivityKey;
  isDue: (caps: SiteState['caps']) => boolean;
}

const ACTIVITY_TODO_RULES: readonly ActivityTodoRule[] = [
  {
    key: 'steamQuests',
    isDue: (caps) => isActivityPending(caps, 'steamQuests'),
  },
  {
    key: 'dailyQuests',
    isDue: (caps) => isActivityPending(caps, 'dailyQuests'),
  },
  {
    key: 'watchTwitch',
    isDue: (caps) => isActivityAvailable(caps, 'watchTwitch'),
  },
  {
    key: 'timeOnSite',
    isDue: (caps) => isActivityAvailable(caps, 'timeOnSite'),
  },
];

const UTC_DAILY_KEYS: ReadonlySet<ActivityKey> = new Set([
  'watchTwitch',
  'dailyQuests',
  'timeOnSite',
]);
const TIME_ON_SITE_DURATION_MS = BASE_ACTIVITY.timeOnSiteBasePerDay * MS_PER_MINUTE;
const STEAM_WEEK_MS = 7 * MS_PER_DAY;

function isUtcDailyActivity(key: ActivityKey): boolean {
  return UTC_DAILY_KEYS.has(key);
}

function activityDurationMs(
  key: ActivityKey,
  watchRemainingMs: number,
): number {
  if (key === 'watchTwitch') {
    return Math.max(0, watchRemainingMs);
  }
  return key === 'timeOnSite' ? TIME_ON_SITE_DURATION_MS : 0;
}

function twitchFullDayMs(
  stats: LoadoutLike | undefined,
  siteState: SiteState,
): number {
  const cap =
    siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay;
  const flat = comboBonusForActivity(stats, 'watchTwitch');
  return (cap + flat) * 60_000;
}

function isActivityEnabled(
  settings: ArtifactOptimizerSettings,
  key: ActivityKey,
): boolean {
  return settings.activities[key].enabled;
}

// ── Activity label helpers ─────────────────────────────────────────────

function phaseChain(phase: ActivityPhase): ActionTodoChain {
  return phase === 'afterNow' || phase === 'after' ? 'after' : 'before';
}

function twitchActivityLabel(options: {
  beforeSwap: boolean;
  utcDeadline: boolean;
  phase: ActivityPhase;
  waitMs: number;
  watchRemainingMs: number;
  utcDailyEndBufferMs: number;
  nowMs: number;
}): string {
  if (options.phase === 'after' || options.phase === 'afterNow') {
    return 'Watch Twitch';
  }
  if (
    options.phase === 'before' &&
    options.waitMs > 0 &&
    !canFinishTwitchAfterUnlock(
      options.waitMs,
      options.watchRemainingMs,
      options.utcDailyEndBufferMs,
      options.nowMs,
    )
  ) {
    return 'Watch Twitch now';
  }
  const swapPart = options.beforeSwap ? ' before swapping' : '';
  return options.utcDeadline
    ? `Watch Twitch${swapPart} (${utcResetDeadlineLabel(new Date(options.nowMs))})`
    : `Watch Twitch${swapPart}`;
}

function twitchArpReason(options: {
  phase: ActivityPhase;
  waitMs: number;
  watchRemainingMs: number;
  allArpPct: number;
  upcomingReset?: 'utc' | 'steam';
  nowMs: number;
}): ActionTodoReason | undefined {
  const arp = Math.round(
    (options.watchRemainingMs / 60_000) * (1 + options.allArpPct),
  );
  if (arp <= 0) {
    return undefined;
  }
  if (options.upcomingReset === 'utc') {
    return { text: `+${String(arp)} ARP after 00:00 UTC` };
  }
  if (options.phase === 'after' && options.waitMs > 0) {
    const left = msAfterUnlockBeforeReset(options.waitMs, options.nowMs);
    if (left > 0) {
      return {
        text: `+${String(arp)} ARP (fits in ${formatMs(left)} before reset)`,
      };
    }
  }
  return { text: `+${String(arp)} ARP` };
}

function discordPollActivityLabel(
  bonus: number,
  options: {
    beforeSwap: boolean;
    phase: ActivityPhase;
    waitMs: number;
    nowMs: number;
  },
): string {
  if (options.phase === 'after') {
    return 'Vote Discord Poll';
  }
  const bonusPart = bonus > 0 ? ` (+${String(bonus)} equipped bonus)` : '';
  const nextPost = formatMs(msUntilNextDiscordPollPost(new Date(options.nowMs)));
  if (options.phase === 'before') {
    return `Vote Discord Poll now — next post in ${nextPost}${bonusPart}`;
  }
  return `Vote Discord Poll${options.beforeSwap ? ' before swapping' : ''}${bonusPart}`;
}

function steamQuestCountLabel(count: number): string {
  if (count === 1) {
    return '1 Steam Quest';
  }
  return count > 1 ? `${String(count)} Steam Quests` : 'Steam Quest(s)';
}

function steamQuestsActivityLabel(
  bonus: number,
  options: {
    beforeSwap: boolean;
    pendingCount: number;
  },
): string {
  const bonusPart = bonus > 0 ? ` (+${String(bonus)} equipped bonus)` : '';
  const beforePart = options.beforeSwap ? ' before swapping' : '';
  return `Complete ${steamQuestCountLabel(options.pendingCount)}${beforePart}${bonusPart}`;
}

function dailyQuestCountLabel(
  pending: readonly { kind: 'daily' | 'weekend' }[],
): string {
  const count = pending.length;
  if (count === 0) {
    return 'Daily Quests';
  }
  const daily = pending.filter((quest) => quest.kind === 'daily').length;
  const weekend = pending.filter((quest) => quest.kind === 'weekend').length;
  if (daily > 0 && weekend > 0) {
    return count === 2
      ? 'Daily and Weekend Quests'
      : `${String(count)} Daily and Weekend Quests`;
  }
  if (weekend > 0) {
    return count === 1 ? 'Weekend Quest' : `${String(count)} Weekend Quests`;
  }
  return count === 1 ? 'Daily Quest' : `${String(count)} Daily Quests`;
}

function dailyQuestsActivityLabel(
  pending: readonly { kind: 'daily' | 'weekend' }[],
  options: {
    beforeSwap: boolean;
    utcDeadline: boolean;
    nowMs: number;
  },
): string {
  const beforePart = options.beforeSwap ? ' before swapping' : '';
  const questsName = dailyQuestCountLabel(pending);
  return options.utcDeadline
    ? `Complete ${questsName} (${utcResetDeadlineLabel(new Date(options.nowMs))})`
    : `Complete ${questsName}${beforePart}`;
}

function activityLabel(
  key: ActivityKey,
  bonus: number,
  options: {
    beforeSwap: boolean;
    utcDeadline: boolean;
    phase: ActivityPhase;
    waitMs: number;
    watchRemainingMs: number;
    utcDailyEndBufferMs: number;
    nowMs: number;
    steamQuestCount?: number;
    dailyQuestPending?: readonly { kind: 'daily' | 'weekend' }[];
  },
): string {
  const beforePart = options.beforeSwap ? ' before swapping' : '';
  switch (key) {
    case 'steamQuests': {
      return steamQuestsActivityLabel(bonus, {
        beforeSwap: options.beforeSwap,
        pendingCount: options.steamQuestCount ?? 0,
      });
    }
    case 'watchTwitch': {
      return twitchActivityLabel(options);
    }
    case 'dailyQuests': {
      return dailyQuestsActivityLabel(options.dailyQuestPending ?? [], {
        beforeSwap: options.beforeSwap,
        utcDeadline: options.utcDeadline,
        nowMs: options.nowMs,
      });
    }
    case 'discordPoll': {
      return discordPollActivityLabel(bonus, options);
    }
    case 'timeOnSite': {
      const equipHint =
        (options.phase === 'after' || options.phase === 'afterNow') && bonus > 0
          ? ' (equip ToS bonus before 5 ARP)'
          : '';
      return `Earn Time on Site ARP${equipHint}${beforePart}`;
    }
    default: {
      return key;
    }
  }
}

// ── Time helpers ───────────────────────────────────────────────────────

function msAfterUnlockBeforeReset(waitMs: number, nowMs: number): number {
  return Math.max(0, msUntilUtcMidnight(new Date(nowMs)) - waitMs);
}

function canFinishTwitchAfterUnlock(
  waitMs: number,
  watchRemainingMs: number,
  bufferMs: number,
  nowMs: number,
): boolean {
  return (
    Math.max(0, msUntilUtcMidnight(new Date(nowMs)) - waitMs - bufferMs) >= watchRemainingMs
  );
}

// ── Build activity todo ────────────────────────────────────────────────

/**
Real ARP at stake for urgency tie-breaks — same units for every activity
(base + flat category bonus, then All-ARP%). Previously Steam / daily /
Discord only reported the flat bonus, so a +1 Steam flat could outrank a
15 ARP Twitch sit.
*/
function activityTodoArp(options: {
  key: ActivityKey;
  bonusForText: number;
  allArpPct: number;
  twitchArp: number;
  siteState: SiteState;
  nowMs: number;
}): number {
  const { key, bonusForText, allArpPct, twitchArp, siteState, nowMs } =
    options;
  if (key === 'watchTwitch') {
    return twitchArp;
  }
  if (key === 'timeOnSite') {
    return Math.round(
      (BASE_ACTIVITY.timeOnSiteBasePerDay + bonusForText) * (1 + allArpPct),
    );
  }
  if (key === 'steamQuests') {
    const bases = remainingSteamQuestRewards(siteState);
    return Math.round(
      (bases.reduce((sum, value) => sum + value, 0) +
        bonusForText * bases.length) *
        (1 + allArpPct),
    );
  }
  if (key === 'dailyQuests') {
    let base = BASE_ACTIVITY.dailyQuestBase;
    const day = new Date(nowMs).getUTCDay();
    if (day === 0 || day === 6) {
      base += BASE_ACTIVITY.weekendQuestBase;
    }
    return Math.round((base + bonusForText) * (1 + allArpPct));
  }
  if (key === 'discordPoll') {
    return Math.round(
      (BASE_ACTIVITY.discordPollBase + bonusForText) * (1 + allArpPct),
    );
  }
  return Math.round(bonusForText * (1 + allArpPct));
}

function activityTodoUrgency(options: {
  key: ActivityKey;
  phase: ActivityPhase;
  waitMs: number;
  watchRemainingMs: number;
  isUtcDaily: boolean;
  bonusForText: number;
  allArpPct: number;
  nowMs: number;
  siteState: SiteState;
}): ActionTodoUrgency {
  const {
    key,
    phase,
    waitMs,
    watchRemainingMs,
    isUtcDaily,
    bonusForText,
    allArpPct,
    nowMs,
    siteState,
  } = options;
  const readyAtMs = phase === 'after' ? waitMs : 0;
  const twitchArp =
    key === 'watchTwitch'
      ? Math.round(
          (Math.max(0, watchRemainingMs) / MS_PER_MINUTE) * (1 + allArpPct),
        )
      : 0;
  return actionUrgency({
    kind: readyAtMs > 0 ? 'schedule' : 'action',
    readyAtMs,
    durationMs: activityDurationMs(key, watchRemainingMs),
    ...(isUtcDaily && { deadlineMs: msUntilUtcMidnight(new Date(nowMs)) }),
    arp: activityTodoArp({
      key,
      bonusForText,
      allArpPct,
      twitchArp,
      siteState,
      nowMs,
    }),
    chain: phaseChain(phase),
  });
}

function steamQuestsTodoExtras(
  siteState: SiteState,
  bonus: number,
): { count: number; reasons?: ActionTodoReason[] } {
  const pending = remainingSteamQuestRows(siteState);
  const reasons: ActionTodoReason[] = [];
  if (bonus > 0) {
    reasons.push({ text: 'Equip bonus before starting' });
  }
  if (pending.some((quest) => quest.libraryPending === true)) {
    reasons.push({ text: STEAM_LIBRARY_PENDING_HINT });
  }
  return reasons.length === 0
    ? { count: pending.length }
    : { count: pending.length, reasons };
}

function dailyQuestsTodoExtras(siteState: SiteState): {
  pending: ReturnType<typeof remainingDailyQuestRows>;
  reasons?: ActionTodoReason[];
} {
  return { pending: remainingDailyQuestRows(siteState) };
}

function activityTodoReasons(options: {
  key: ActivityKey;
  phase: ActivityPhase;
  waitMs: number;
  watchRemainingMs: number;
  allArpPct: number;
  upcomingReset?: 'utc' | 'steam';
  steamQuests?: { reasons?: ActionTodoReason[] };
  dailyQuests?: { reasons?: ActionTodoReason[] };
  nowMs: number;
}): ActionTodoReason[] | undefined {
  const {
    key,
    phase,
    waitMs,
    watchRemainingMs,
    allArpPct,
    upcomingReset,
    steamQuests,
    dailyQuests,
    nowMs,
  } = options;
  const reasons: ActionTodoReason[] = [];
  if (key === 'watchTwitch') {
    const twitchReason = twitchArpReason({
      phase,
      waitMs,
      watchRemainingMs,
      allArpPct,
      ...(upcomingReset && { upcomingReset }),
      nowMs,
    });
    if (twitchReason) {
      reasons.push(twitchReason);
    }
  } else if (steamQuests?.reasons) {
    reasons.push(...steamQuests.reasons);
  } else if (dailyQuests?.reasons) {
    reasons.push(...dailyQuests.reasons);
  }
  if (upcomingReset === 'steam') {
    reasons.push({ text: 'after Monday 00:00 UTC reset' });
  } else if (upcomingReset === 'utc' && key !== 'watchTwitch') {
    reasons.push({ text: 'after 00:00 UTC reset' });
  }
  return reasons.length > 0 ? reasons : undefined;
}

function buildActivityTodo(options: {
  key: ActivityKey;
  phase: ActivityPhase;
  needsSwap: boolean;
  currentBonus: number;
  bestBonus: number;
  afterNowBonus: number;
  isUtcDaily: boolean;
  waitMs: number;
  watchRemainingMs: number;
  allArpPct: number;
  siteState: SiteState;
  utcDailyEndBufferMs: number;
  nowMs: number;
  upcomingReset?: 'utc' | 'steam';
}): ActionTodo {
  const {
    key,
    phase,
    needsSwap,
    currentBonus,
    bestBonus,
    afterNowBonus,
    isUtcDaily,
    waitMs,
    watchRemainingMs,
    allArpPct,
    siteState,
    utcDailyEndBufferMs: cutoffMs,
    nowMs,
    upcomingReset,
  } = options;
  const bonusForText = bonusForActivityPhase(
    phase,
    currentBonus,
    bestBonus,
    afterNowBonus,
  );
  const steamQuests =
    key === 'steamQuests'
      ? steamQuestsTodoExtras(siteState, bonusForText)
      : undefined;
  const dailyQuests =
    key === 'dailyQuests' ? dailyQuestsTodoExtras(siteState) : undefined;
  const todo: ActionTodo = {
    text: activityLabel(key, bonusForText, {
      beforeSwap: phase === 'before' && needsSwap && currentBonus > 0,
      utcDeadline: isUtcDaily && upcomingReset === undefined,
      phase,
      waitMs,
      watchRemainingMs,
      utcDailyEndBufferMs: cutoffMs,
      nowMs,
      ...(steamQuests && { steamQuestCount: steamQuests.count }),
      ...(dailyQuests && { dailyQuestPending: dailyQuests.pending }),
    }),
    urgency: activityTodoUrgency({
      key,
      phase,
      waitMs,
      watchRemainingMs,
      isUtcDaily: isUtcDaily && upcomingReset === undefined,
      bonusForText,
      allArpPct,
      nowMs,
      siteState,
    }),
  };

  const reasons = activityTodoReasons({
    key,
    phase,
    waitMs,
    watchRemainingMs,
    allArpPct,
    nowMs,
    ...(upcomingReset && { upcomingReset }),
    ...(steamQuests && { steamQuests }),
    ...(dailyQuests && { dailyQuests }),
  });
  if (reasons) {
    todo.reasons = reasons;
  }
  if (key === 'watchTwitch' && upcomingReset === undefined) {
    todo.openTwitchStream = true;
  }

  const isUtcUrgent =
    isUtcDaily &&
    upcomingReset === undefined &&
    msUntilUtcMidnight(new Date(nowMs)) <= 2 * 3_600_000;
  if (isUtcUrgent) {
    todo.tone = 'warn';
  }

  return todo;
}

// ── Activity bucket helpers ────────────────────────────────────────────

function pushTodoByPhase(
  buckets: {
    beforeSwap: ActionTodo[];
    afterNow: ActionTodo[];
    afterSwap: ActionTodo[];
    other: ActionTodo[];
  },
  phase: ActivityPhase,
  todo: ActionTodo,
): void {
  if (phase === 'before') {
    buckets.beforeSwap.push(todo);
    return;
  }
  if (phase === 'afterNow') {
    buckets.afterNow.push(todo);
    return;
  }
  if (phase === 'after') {
    buckets.afterSwap.push(todo);
    return;
  }
  buckets.other.push(todo);
}

function utcResetTodoRank(todo: ActionTodo): number {
  if (/(Daily|Weekend) quest/i.test(todo.text)) {
    return 0;
  }
  return /Watch Twitch/i.test(todo.text) ? 1 : 2;
}

function sortTodosByUtcDeadline(items: ActionTodo[]): ActionTodo[] {
  return items.toSorted((left, right) => {
    const leftUrgent = /00:00 UTC/i.test(left.text) ? 0 : 1;
    const rightUrgent = /00:00 UTC/i.test(right.text) ? 0 : 1;
    return leftUrgent === rightUrgent
      ? utcResetTodoRank(left) - utcResetTodoRank(right)
      : leftUrgent - rightUrgent;
  });
}

function upcomingResetAtMs(
  key: ActivityKey,
  siteState: SiteState,
  plannedWear: PlannedWear | undefined,
  isTodayDue: boolean,
  nowMs: number,
): number | undefined {
  if (!plannedWear || isTodayDue) {
    return undefined;
  }
  if (key === 'steamQuests') {
    if (isActivityPending(siteState.caps, 'steamQuests')) {
      return undefined;
    }
    const monday = msUntilNextSteamQuestWeek(nowMs);
    return canCompleteInWearWindow(
      monday,
      monday + STEAM_WEEK_MS,
      plannedWear.waitMs,
      0,
    )
      ? monday
      : undefined;
  }
  if (!isUtcDailyActivity(key)) {
    return undefined;
  }
  const midnight = msUntilUtcMidnight(new Date(nowMs));
  const duration =
    key === 'watchTwitch'
      ? twitchFullDayMs(plannedWear.stats, siteState)
      : activityDurationMs(key, 0);
  return canCompleteInWearWindow(
    midnight,
    midnight + 86_400_000,
    plannedWear.waitMs,
    duration,
  )
    ? midnight
    : undefined;
}

function waitMsForActivityPhase(
  phase: ActivityPhase,
  delayWaitMs: number,
  waitMs: number,
): number {
  if (phase === 'afterNow') {
    return 0;
  }
  return phase === 'after' ? delayWaitMs : waitMs;
}

// ── Phase resolution ───────────────────────────────────────────────────

function resolveUtcDailyPhase(options: {
  key: ActivityKey;
  needsSwap: boolean;
  waitMs: number;
  current: OptimizerResult['current'];
  best: OptimizerResult['best'];
  afterNow: ActivityLoadoutStats | undefined;
  hasImmediateEquip: boolean;
  watchRemainingMs: number;
  siteState: SiteState;
  plannedWear: PlannedWear | undefined;
  utcDailyEndBufferMs: number;
  nowMs: number;
}): ActivityPhase {
  const {
    key,
    needsSwap,
    waitMs,
    current,
    best,
    afterNow,
    hasImmediateEquip,
    watchRemainingMs,
    siteState,
    plannedWear,
    utcDailyEndBufferMs: cutoffMs,
    nowMs,
  } = options;
  const currentArp = activityWindowArp(current, key, siteState, nowMs);
  const afterNowArp = activityWindowArp(
    afterNow ?? current,
    key,
    siteState,
    nowMs,
  );
  if (needsSwap && hasImmediateEquip && afterNowArp >= currentArp) {
    return 'afterNow';
  }
  const futureWaitMs = plannedWear?.waitMs ?? waitMs;
  const futureStats = plannedWear?.stats ?? best;
  const futureArp = activityWindowArp(futureStats, key, siteState, nowMs);
  const durationMs = activityDurationMs(key, watchRemainingMs);
  const isFitsAfterFuture =
    key === 'watchTwitch'
      ? canFinishTwitchAfterUnlock(futureWaitMs, watchRemainingMs, cutoffMs, nowMs)
      : canCompleteInWearWindow(
          0,
          msUntilUtcMidnight(new Date(nowMs)),
          futureWaitMs,
          durationMs,
        );
  return isFitsAfterFuture && futureArp > currentArp ? 'after' : 'before';
}

function resolveActivityPhase(options: {
  key: ActivityKey;
  needsSwap: boolean;
  expiresBeforeUnlock: boolean;
  currentBonus: number;
  bestBonus: number;
  afterNowBonus: number;
  waitMs: number;
  canEquipBeforeReset: boolean;
  isUtcDaily: boolean;
  current: OptimizerResult['current'];
  best: OptimizerResult['best'];
  afterNow: ActivityLoadoutStats | undefined;
  hasImmediateEquip: boolean;
  watchRemainingMs: number;
  siteState: SiteState;
  plannedWear: PlannedWear | undefined;
  utcDailyEndBufferMs: number;
  nowMs: number;
}): ActivityPhase {
  const {
    key,
    needsSwap,
    expiresBeforeUnlock,
    currentBonus,
    bestBonus,
    afterNowBonus,
    waitMs,
    canEquipBeforeReset,
    isUtcDaily,
    current,
    best,
    afterNow,
    hasImmediateEquip,
    watchRemainingMs,
    siteState,
    plannedWear,
    utcDailyEndBufferMs: cutoffMs,
    nowMs,
  } = options;

  if (isUtcDaily) {
    return resolveUtcDailyPhase({
      key,
      needsSwap,
      waitMs,
      current,
      best,
      afterNow,
      hasImmediateEquip,
      watchRemainingMs,
      siteState,
      plannedWear,
      utcDailyEndBufferMs: cutoffMs,
      nowMs,
    });
  }

  if (
    key === 'steamQuests' &&
    plannedWear &&
    activityWindowArp(plannedWear.stats, key, siteState, nowMs) >
      activityWindowArp(current, key, siteState, nowMs) &&
    canCompleteInWearWindow(
      0,
      msUntilNextSteamQuestWeek(nowMs),
      plannedWear.waitMs,
      0,
    )
  ) {
    return 'after';
  }

  if (!needsSwap) {
    return 'other';
  }

  if (hasImmediateEquip && afterNowBonus >= currentBonus) {
    return 'afterNow';
  }

  if (expiresBeforeUnlock || currentBonus > bestBonus) {
    return 'before';
  }

  if (bestBonus > currentBonus && (waitMs === 0 || canEquipBeforeReset)) {
    return 'after';
  }

  if (currentBonus > 0 && currentBonus >= bestBonus) {
    return 'before';
  }

  if (bestBonus <= 0) {
    return 'other';
  }

  return !canEquipBeforeReset && waitMs > 0 ? 'other' : 'after';
}

function allArpPctForPhase(
  phase: ActivityPhase,
  current: OptimizerResult['current'],
  best: OptimizerResult['best'],
  afterNow: ActivityLoadoutStats | undefined,
  plannedWear?: PlannedWear,
): number {
  if (phase === 'after') {
    return plannedWear?.stats.allArpPct ?? best?.allArpPct ?? 0;
  }
  return phase === 'afterNow'
    ? (afterNow?.allArpPct ?? current?.allArpPct ?? 0)
    : (current?.allArpPct ?? 0);
}

function appendDueActivityTodo(options: {
  buckets: {
    beforeSwap: ActionTodo[];
    afterNow: ActionTodo[];
    afterSwap: ActionTodo[];
    other: ActionTodo[];
  };
  rule: ActivityTodoRule;
  needsSwap: boolean;
  current: OptimizerResult['current'];
  best: OptimizerResult['best'];
  afterNow: ActivityLoadoutStats | undefined;
  hasImmediateEquip: boolean;
  watchAfterMs: number;
  siteState: SiteState;
  plannedWear: PlannedWear | undefined;
  currentBonus: number;
  bestBonus: number;
  afterNowBonus: number;
  isUtcDaily: boolean;
  delayWaitMs: number;
  waitMs: number;
  isExpiresBeforeUnlock: boolean;
  utcDailyEndBufferMs: number;
  nowMs: number;
}): void {
  const {
    buckets,
    rule,
    needsSwap,
    current,
    best,
    afterNow,
    hasImmediateEquip,
    watchAfterMs,
    siteState,
    plannedWear,
    currentBonus,
    bestBonus,
    afterNowBonus,
    isUtcDaily,
    delayWaitMs,
    waitMs,
    isExpiresBeforeUnlock,
    utcDailyEndBufferMs: cutoffMs,
    nowMs,
  } = options;
  const phase = resolveActivityPhase({
    key: rule.key,
    needsSwap,
    expiresBeforeUnlock: isExpiresBeforeUnlock,
    currentBonus,
    bestBonus,
    afterNowBonus,
    waitMs: delayWaitMs,
    canEquipBeforeReset: delayWaitMs <= msUntilUtcMidnight(new Date(nowMs)),
    isUtcDaily,
    current,
    best,
    afterNow,
    hasImmediateEquip,
    watchRemainingMs: watchAfterMs,
    siteState,
    plannedWear,
    utcDailyEndBufferMs: cutoffMs,
    nowMs,
  });
  const watchRemainingMs =
    rule.key === 'watchTwitch'
      ? twitchWatchRemainingMs(
          siteState,
          bonusForActivityPhase(phase, currentBonus, bestBonus, afterNowBonus),
        )
      : watchAfterMs;
  pushTodoByPhase(
    buckets,
    phase,
    buildActivityTodo({
      key: rule.key,
      phase,
      needsSwap,
      currentBonus,
      bestBonus,
      afterNowBonus,
      isUtcDaily,
      waitMs: waitMsForActivityPhase(phase, delayWaitMs, waitMs),
      watchRemainingMs,
      allArpPct: allArpPctForPhase(phase, current, best, afterNow, plannedWear),
      siteState,
      utcDailyEndBufferMs: cutoffMs,
      nowMs,
    }),
  );
}

function appendUpcomingActivityTodo(options: {
  buckets: {
    beforeSwap: ActionTodo[];
    afterNow: ActionTodo[];
    afterSwap: ActionTodo[];
    other: ActionTodo[];
  };
  rule: ActivityTodoRule;
  needsSwap: boolean;
  plannedWear: PlannedWear;
  upcomingAt: number;
  currentBonus: number;
  bestBonus: number;
  afterNowBonus: number;
  isUtcDaily: boolean;
  watchAfterMs: number;
  siteState: SiteState;
  utcDailyEndBufferMs: number;
  nowMs: number;
}): void {
  const {
    buckets,
    rule,
    needsSwap,
    plannedWear,
    upcomingAt,
    currentBonus,
    bestBonus,
    afterNowBonus,
    isUtcDaily,
    watchAfterMs,
    siteState,
    utcDailyEndBufferMs: cutoffMs,
    nowMs,
  } = options;
  const upcomingWatchMs =
    rule.key === 'watchTwitch'
      ? twitchFullDayMs(plannedWear.stats, siteState)
      : watchAfterMs;
  pushTodoByPhase(
    buckets,
    'after',
    buildActivityTodo({
      key: rule.key,
      phase: 'after',
      needsSwap,
      currentBonus,
      bestBonus,
      afterNowBonus,
      isUtcDaily,
      waitMs: Math.max(upcomingAt, plannedWear.waitMs),
      watchRemainingMs: upcomingWatchMs,
      allArpPct: plannedWear.stats.allArpPct,
      siteState,
      utcDailyEndBufferMs: cutoffMs,
      nowMs,
      upcomingReset: rule.key === 'steamQuests' ? 'steam' : 'utc',
    }),
  );
}

function isSequencedActivityDue(
  rule: ActivityTodoRule,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  watchRemainingMs: number,
): boolean {
  if (!isActivityEnabled(settings, rule.key)) {
    return false;
  }
  return rule.key === 'watchTwitch'
    ? watchRemainingMs > 0 && isActivityAvailable(siteState.caps, 'watchTwitch')
    : rule.isDue(siteState.caps);
}

// ── Community event todo ───────────────────────────────────────────────

function waitingPersonalPlayMs(
  event: NonNullable<SiteState['communityEvent']>,
): number {
  let needHours = 0;
  for (const milestone of event.milestones) {
    if (
      milestone.isAwarded ||
      milestone.arpReward <= 0 ||
      !isCommunityGateMet(milestone, event.communityHours) ||
      isPersonalHoursMet(milestone, event.personalHours)
    ) {
      continue;
    }
    if (milestone.personalHoursRequired > needHours) {
      needHours = milestone.personalHoursRequired;
    }
  }
  return Math.max(0, needHours - event.personalHours) * 3_600_000;
}

function communityEventTodoUrgency(
  event: NonNullable<SiteState['communityEvent']>,
  pending: ReturnType<typeof breakDownCommunityEventPending>,
  etaMs: number | undefined,
): ActionTodoUrgency {
  if (pending.waitingPersonalArp > 0) {
    // After All-ARP% equip — not before. Ranking "before" put "play 4h more"
    // above the equip step that says to gear up first. Duration is the grind
    // window so shorter UTC-capped work (Twitch) still ranks ahead of CE hours.
    return actionUrgency({
      kind: 'action',
      readyAtMs: 0,
      durationMs: waitingPersonalPlayMs(event),
      arp: pending.waitingPersonalArp,
      chain: 'after',
    });
  }
  const waitingArp =
    pending.waitingCommunityArp +
    pending.imminentArp +
    pending.waitingPersonalArp;
  if (etaMs === undefined) {
    return actionUrgency({
      kind: 'info',
      readyAtMs: 0,
      durationMs: 0,
      arp: waitingArp,
    });
  }
  return actionUrgency({
    kind: 'schedule',
    readyAtMs: etaMs,
    durationMs: 0,
    deadlineMs: etaMs,
    arp: waitingArp,
  });
}

function pushCommunityEventTodo(
  todos: ActionTodo[],
  siteState: SiteState,
  settings: ArtifactOptimizerSettings,
  allArpPct = 0,
  nowMs = Date.now(),
): void {
  const event = siteState.communityEvent;
  if (
    !isActivityEnabled(settings, 'steamCommunityEvent') ||
    !event?.isLive ||
    !canEarnCommunityEventArp(event)
  ) {
    return;
  }
  const pending = breakDownCommunityEventPending(event);
  if (
    pending.pendingCount <= 0 &&
    nextLockedCommunityArpMilestone(event) === undefined
  ) {
    return;
  }
  const { text, later } = describeCommunityEventPendingParts(event, allArpPct);
  const reasons: ActionTodoReason[] = [];
  if (later) {
    reasons.push({ text: later });
  }
  if (event.libraryPending) {
    reasons.push({ text: STEAM_LIBRARY_PENDING_HINT });
  }
  const todo: ActionTodo = {
    text: `Community Event: ${text}`,
    urgency: communityEventTodoUrgency(
      event,
      pending,
      estimateNextCommunityUnlock(event, nowMs)?.etaMs,
    ),
  };
  if (reasons.length > 0) {
    todo.reasons = reasons;
  }
  todos.push(todo);
}

// ── Sequenced activities (public) ──────────────────────────────────────

export function buildSequencedActivityTodos(
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  options: {
    needsSwap: boolean;
    waitMs: number;
    nowMs: number;
  },
): {
  beforeSwap: ActionTodo[];
  afterNow: ActionTodo[];
  afterSwap: ActionTodo[];
  other: ActionTodo[];
} {
  const buckets = {
    beforeSwap: [] as ActionTodo[],
    afterNow: [] as ActionTodo[],
    afterSwap: [] as ActionTodo[],
    other: [] as ActionTodo[],
  };
  const { needsSwap, waitMs: fallbackWaitMs, nowMs } = options;
  const current = result.current;
  const best = result.best;
  const plan = best
    ? planLoadoutChanges(best.artifacts, current, settings, result.slotLocks, nowMs)
    : undefined;
  const waitMs = plan?.waitMs ?? fallbackWaitMs;
  const cutoffMs = utcDailyEndBufferMs(settings);
  const plannedWear = plannedWearForResets(result, waitMs);
  const hasImmediateEquip = (plan?.now.length ?? 0) > 0;
  const afterNow =
    best && plan
      ? activityStatsForArtifacts(
          artifactsAfterImmediateEquip(current, best, plan),
        )
      : undefined;
  const twitchFlatForDue = Math.max(
    comboBonusForActivity(current, 'watchTwitch'),
    comboBonusForActivity(afterNow ?? current, 'watchTwitch'),
    comboBonusForActivity(best, 'watchTwitch'),
    comboBonusForActivity(plannedWear?.stats, 'watchTwitch'),
  );
  const watchAfterMs = twitchWatchRemainingMs(siteState, twitchFlatForDue);

  for (const rule of ACTIVITY_TODO_RULES) {
    if (!isActivityEnabled(settings, rule.key)) {
      continue;
    }
    const isTodayDue = isSequencedActivityDue(
      rule,
      settings,
      siteState,
      watchAfterMs,
    );
    const upcomingAt = upcomingResetAtMs(
      rule.key,
      siteState,
      plannedWear,
      isTodayDue,
      nowMs,
    );
    if (!isTodayDue && upcomingAt === undefined) {
      continue;
    }

    const currentBonus = comboBonusForActivity(current, rule.key);
    const bestBonus = comboBonusForActivity(
      plannedWear?.stats ?? best,
      rule.key,
    );
    const afterNowBonus = comboBonusForActivity(afterNow ?? current, rule.key);
    const isUtcDaily = isUtcDailyActivity(rule.key);
    const delayWaitMs = plannedWear?.waitMs ?? waitMs;
    const isExpiresBeforeUnlock =
      isUtcDaily && delayWaitMs > msUntilUtcMidnight(new Date(nowMs)) && delayWaitMs > 0;

    if (isTodayDue) {
      appendDueActivityTodo({
        buckets,
        rule,
        needsSwap,
        current,
        best,
        afterNow,
        hasImmediateEquip,
        watchAfterMs,
        siteState,
        plannedWear,
        currentBonus,
        bestBonus,
        afterNowBonus,
        isUtcDaily,
        delayWaitMs,
        waitMs,
        isExpiresBeforeUnlock,
        utcDailyEndBufferMs: cutoffMs,
        nowMs,
      });
    }

    if (upcomingAt !== undefined && plannedWear) {
      appendUpcomingActivityTodo({
        buckets,
        rule,
        needsSwap,
        plannedWear,
        upcomingAt,
        currentBonus,
        bestBonus,
        afterNowBonus,
        isUtcDaily,
        watchAfterMs,
        siteState,
        utcDailyEndBufferMs: cutoffMs,
        nowMs,
      });
    }
  }

  pushCommunityEventTodo(
    buckets.other,
    siteState,
    settings,
    current?.allArpPct ?? 0,
    nowMs,
  );

  return {
    beforeSwap: sortTodosByUtcDeadline(buckets.beforeSwap),
    afterNow: sortTodosByUtcDeadline(buckets.afterNow),
    afterSwap: sortTodosByUtcDeadline(buckets.afterSwap),
    other: sortTodosByUtcDeadline(buckets.other),
  };
}
