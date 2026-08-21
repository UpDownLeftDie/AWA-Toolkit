import {
  ArtifactEffectType,
  BASE_ACTIVITY,
  getArtifactById,
  msUntilNextDiscordPollPost,
  TIER_LABELS,
} from '../data';
import {
  type ActivityLoadoutStats,
  activityStatsForArtifacts,
  canCompleteInWearWindow,
  isResetInWearWindow,
  msUntilNextSteamQuestWeek,
  type OptimizerResult,
  type ScoredCombo,
  type UpgradeSuggestion,
  VAULT_PRIORITY_DISCOUNT_PCT,
} from '../optimizer';
import { isArtifactsShowroomPage, type OwnedArtifact } from '../scraper';
import {
  type ArtifactOptimizerSettings,
  COOLDOWN_MS,
  showroomCooldownRemainingMs,
  utcDailyEndBufferMs,
} from '../settings';
import {
  type ActivityKey,
  battlePassClaimableArp,
  battlePassReadyNonArp,
  battlePassRemainingMs,
  breakDownCommunityEventPending,
  canEarnCommunityEventArp,
  describeCommunityEventPendingParts,
  estimateNextCommunityUnlock,
  formatCommunityEta,
  formatCommunityEventArp,
  hasVotedCurrentDiscordPoll,
  isActivityAvailable,
  isActivityPending,
  nextLockedCommunityArpMilestone,
  remainingDailyQuestRows,
  remainingSteamQuestRewards,
  remainingSteamQuestRows,
  type SiteState,
  twitchWatchRemainingMs,
} from '../siteState';
import {
  battlePassClaimButtonLabel,
  shouldShowBattlePassClaimAll,
} from '../siteState/battlePass';
import { describeWaitingCommunityArpLine } from '../siteState/communityEvent';
import { STEAM_LIBRARY_PENDING_HINT } from '../steamApp';
import { wrapArtifactNames } from './artifactTip';
import {
  artifactsAfterImmediateEquip,
  escapeHtml,
  formatMs,
  hasAnySlotOnCooldown,
  isSameLoadout,
  type LoadoutChangePlan,
  loadoutLabel,
  maxSlotCooldownMs,
  msUntilUtcMidnight,
  planLoadoutChanges,
  utcResetDeadlineLabel,
} from './loadoutPlan';

export type ActionTone = 'default' | 'muted' | 'warn';

/**
 * How a step competes in the final "What to do" order.
 *
 * Sort: kind → readyAt → chain → duration → deadline slack → ARP.
 * Ready-now actions beat scheduled waits. Dailies delayed until a later
 * All-ARP% equip use kind "schedule" so they sit after that equip (chain)
 * instead of jumping to #1 when 00:00 UTC refreshes Watch Twitch.
 */
export type ActionTodoUrgencyKind = 'action' | 'schedule' | 'info';

/**
 * Soft dependency relative to an equip/swap step.
 */
export type ActionTodoChain = 'before' | 'equip' | 'after';

type LoadoutLike = ActivityLoadoutStats | ScoredCombo | undefined;

export interface ActionTodoUrgency {
  kind: ActionTodoUrgencyKind;
  /**
   * ms until the user can start (0 = now).
   */
  readyAtMs: number;
  /**
   * ms to finish once started (0 = instant click).
   */
  durationMs: number;
  /**
   * ms until a hard loss deadline; omit when none.
   */
  deadlineMs?: number;
  /**
   * ARP at stake for tie-breaks.
   */
  arp?: number;
  chain?: ActionTodoChain;
}

function actionUrgency(partial: {
  kind: ActionTodoUrgencyKind;
  readyAtMs: number;
  durationMs: number;
  deadlineMs?: number;
  arp?: number;
  chain?: ActionTodoChain;
}): ActionTodoUrgency {
  const urgency: ActionTodoUrgency = {
    kind: partial.kind,
    readyAtMs: partial.readyAtMs,
    durationMs: partial.durationMs,
  };
  if (partial.deadlineMs !== undefined) {
    urgency.deadlineMs = partial.deadlineMs;
  }
  if (partial.arp !== undefined) {
    urgency.arp = partial.arp;
  }
  if (partial.chain !== undefined) {
    urgency.chain = partial.chain;
  }
  return urgency;
}

export interface ActionTodoReason {
  text: string;
  /**
  Secondary line under this reason (e.g. community progress / ETA).
  */
  detail?: string;
}

export interface ActionTodo {
  text: string;
  /**
  Artifact names on their own line under the headline.
  */
  loadout?: string;
  /**
  Why / what this step is for — rendered as a short list.
  */
  reasons?: ActionTodoReason[];
  tone?: ActionTone;
  /**
  Unnumbered warning above the list (don't-do-this), not a step.
  */
  kind?: 'caution';
  /**
  Affordable META upgrade — renders a confirm+Upgrade button on this step.
  */
  upgradeInstanceId?: number;
  /**
  Ready Battle Pass rewards — renders a claim button on this step.
  */
  claimBattlePass?: boolean;
  /**
  Leave ARP Boosts unclaimed (All-ARP% wait). Claim cosmetics/fragments only.
  */
  claimBattlePassSkipArp?: boolean;
  /**
  Watch Twitch step — renders an Open stream button that picks a live channel.
  */
  openTwitchStream?: boolean;
  /**
  Achievement helper — navigate (or background-visit) this path.
  */
  openHref?: string;
  openHrefLabel?: string;
  /**
  Fetch the href in a hidden request instead of leaving the page.
  */
  visitInBackground?: boolean;
  /**
  Final list order — phases still decide wording / swap sequencing metadata.
  */
  urgency?: ActionTodoUrgency;
}

type ActivityPhase = 'before' | 'afterNow' | 'after' | 'other';

const CHAIN_RANK: Record<ActionTodoChain, number> = {
  before: 0,
  equip: 1,
  after: 2,
};

const URGENCY_KIND_RANK: Record<ActionTodoUrgencyKind, number> = {
  action: 0,
  schedule: 1,
  info: 2,
};

function urgencyDeadlineMs(urgency: ActionTodoUrgency): number {
  return urgency.deadlineMs ?? Number.POSITIVE_INFINITY;
}

function compareActionTodoUrgency(
  left: ActionTodoUrgency,
  right: ActionTodoUrgency,
): number {
  const kindDelta =
    URGENCY_KIND_RANK[left.kind] - URGENCY_KIND_RANK[right.kind];
  if (kindDelta !== 0) {
    return kindDelta;
  }
  if (left.readyAtMs !== right.readyAtMs) {
    return left.readyAtMs - right.readyAtMs;
  }
  const leftChain = CHAIN_RANK[left.chain ?? 'before'];
  const rightChain = CHAIN_RANK[right.chain ?? 'before'];
  if (leftChain !== rightChain) {
    return leftChain - rightChain;
  }
  if (left.durationMs !== right.durationMs) {
    return left.durationMs - right.durationMs;
  }
  const leftSlack = urgencyDeadlineMs(left) - left.durationMs;
  const rightSlack = urgencyDeadlineMs(right) - right.durationMs;
  if (leftSlack !== rightSlack) {
    return leftSlack - rightSlack;
  }
  return (right.arp ?? 0) - (left.arp ?? 0);
}

function defaultTodoUrgency(todo: ActionTodo): ActionTodoUrgency {
  if (todo.tone === 'muted' && !todo.loadout) {
    return { kind: 'info', readyAtMs: 0, durationMs: 0 };
  }
  return { kind: 'action', readyAtMs: 0, durationMs: 0 };
}

/**
 * Global order for numbered steps. Cautions stay pinned above via render.
 */
function sortActionTodosByUrgency(todos: ActionTodo[]): ActionTodo[] {
  return todos.toSorted((left, right) =>
    compareActionTodoUrgency(
      left.urgency ?? defaultTodoUrgency(left),
      right.urgency ?? defaultTodoUrgency(right),
    ),
  );
}

function phaseChain(phase: ActivityPhase): ActionTodoChain {
  // afterNow = after the immediate equip, not tied with it (ARP would rank
  // Steam Quests above "Equip … now").
  if (phase === 'afterNow' || phase === 'after') {
    return 'after';
  }
  return 'before';
}

type ActivityTodoRule = {
  key: ActivityKey;
  isDue: (caps: SiteState['caps']) => boolean;
};

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
const TIME_ON_SITE_DURATION_MS = BASE_ACTIVITY.timeOnSiteBasePerDay * 60_000;
const STEAM_WEEK_MS = 7 * 86_400_000;

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
  if (key === 'timeOnSite') {
    return TIME_ON_SITE_DURATION_MS;
  }
  return 0;
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

function loadoutStats(combo: LoadoutLike): ActivityLoadoutStats | undefined {
  if (!combo) {
    return undefined;
  }
  if ('artifacts' in combo && combo.artifacts.length > 0) {
    return activityStatsForArtifacts(combo.artifacts);
  }
  if ('timeOnSiteFlat' in combo) {
    return combo;
  }
  return undefined;
}

type PlannedWear = {
  stats: ActivityLoadoutStats;
  waitMs: number;
};

function plannedWearForResets(
  result: OptimizerResult,
  swapWaitMs: number,
): PlannedWear | undefined {
  const deferred = result.deferredAllArp;
  if (deferred && deferred.waitMs > 0 && deferred.artifacts.length > 0) {
    return {
      stats: activityStatsForArtifacts(deferred.artifacts),
      waitMs: deferred.waitMs,
    };
  }
  const steam = result.deferredSteam;
  if (steam && steam.artifacts.length > 0) {
    return {
      stats: activityStatsForArtifacts(steam.artifacts),
      waitMs: steam.waitMs,
    };
  }
  const best = result.best;
  const current = result.current;
  if (
    best &&
    (best.allArpPct ?? 0) > (current?.allArpPct ?? 0) &&
    swapWaitMs > 0
  ) {
    return {
      stats: activityStatsForArtifacts(best.artifacts),
      waitMs: swapWaitMs,
    };
  }
  return undefined;
}

function isActivityEnabled(
  settings: ArtifactOptimizerSettings,
  key: ActivityKey,
): boolean {
  return settings.activities[key]?.enabled;
}

function communityEventTodoUrgency(
  pending: ReturnType<typeof breakDownCommunityEventPending>,
  etaMs: number | undefined,
): ActionTodoUrgency {
  if (pending.waitingPersonalArp > 0) {
    return actionUrgency({
      kind: 'action',
      readyAtMs: 0,
      durationMs: 0,
      arp: pending.waitingPersonalArp,
      chain: 'before',
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
      pending,
      estimateNextCommunityUnlock(event)?.etaMs,
    ),
  };
  if (reasons.length > 0) {
    todo.reasons = reasons;
  }
  todos.push(todo);
}

function battlePassClaimCountLabel(readyAll: number, readyArp: number): string {
  if (readyArp <= 0) {
    return readyAll === 1
      ? '1 Battle Pass reward'
      : `${readyAll} Battle Pass rewards`;
  }
  if (readyAll === readyArp) {
    return readyArp === 1
      ? '1 Battle Pass ARP Boost'
      : `${readyArp} Battle Pass ARP Boosts`;
  }
  const boosts = readyArp === 1 ? '1 ARP Boost' : `${readyArp} ARP Boosts`;
  return `${readyAll} Battle Pass rewards (${boosts})`;
}

function holdArpBoostReason(readyArp: number): string {
  const arpLabel = readyArp === 1 ? '1 ARP Boost' : `${readyArp} ARP Boosts`;
  return `Hold ${arpLabel} until All-ARP% is on`;
}

/**
 * All-ARP% is owned but not equipped, and the season still has time.
 * Claim cosmetics/fragments now; leave ARP Boosts until All-ARP% is on.
 */
function pushHeldArpBattlePassTodos(
  todos: ActionTodo[],
  siteState: SiteState,
  readyArp: number,
  hasScheduledAllArp: boolean,
  allArpReadyAtMs = 0,
): void {
  const nonArp = battlePassReadyNonArp(siteState.battlePass);
  if (nonArp > 0) {
    const reasons: ActionTodoReason[] = [
      { text: holdArpBoostReason(readyArp) },
    ];
    if (!hasScheduledAllArp) {
      reasons.push({
        text: 'More boosts may unlock — claim those when All-ARP% is already on',
      });
    }
    todos.push({
      text: `Claim ${battlePassClaimCountLabel(nonArp, 0)} now`,
      reasons,
      claimBattlePass: true,
      claimBattlePassSkipArp: true,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        chain: 'before',
      },
    });
  }
  if (hasScheduledAllArp) {
    todos.push({
      text: `Claim ${battlePassClaimCountLabel(readyArp, readyArp)}`,
      urgency: {
        kind: 'schedule',
        readyAtMs: allArpReadyAtMs,
        durationMs: 0,
        arp: readyArp,
        chain: 'after',
      },
    });
  }
}

function pushBattlePassTodo(
  todos: ActionTodo[],
  siteState: SiteState,
  options: {
    ownsAllArp: boolean;
    hasAllArpEquipped: boolean;
    /**
    Claim comes after a planned All-ARP% equip step — don't restate unlock timing.
    */
    afterAllArpEquipped?: boolean;
    /**
    When All-ARP% is a later step, align the claim step with that wait.
    */
    allArpReadyAtMs?: number;
    /**
    Season ends before All-ARP% can be equipped — claim on the current set.
    */
    seasonEndsBeforeAllArp?: boolean;
  },
): void {
  const readyAll = siteState.battlePass?.readyToClaim ?? 0;
  if (readyAll <= 0) {
    return;
  }
  const readyArp = battlePassClaimableArp(siteState.battlePass);

  const {
    ownsAllArp,
    hasAllArpEquipped,
    afterAllArpEquipped = false,
    seasonEndsBeforeAllArp = false,
    allArpReadyAtMs = 0,
  } = options;
  const shouldWaitForAllArpSwap =
    ownsAllArp && !hasAllArpEquipped && !seasonEndsBeforeAllArp;
  const shouldShowClaimAll = shouldShowBattlePassClaimAll(
    siteState.battlePass,
    shouldWaitForAllArpSwap,
  );
  const countLabel = battlePassClaimCountLabel(readyAll, readyArp);

  if (readyArp <= 0) {
    todos.push({
      text: `Claim ${countLabel}`,
      claimBattlePass: shouldShowClaimAll,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        chain: 'before',
      },
    });
    return;
  }

  if (hasAllArpEquipped) {
    todos.push({
      text: `Claim ${countLabel} now — All-ARP% is equipped`,
      claimBattlePass: shouldShowClaimAll,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        arp: readyArp,
        chain: 'before',
      },
    });
    return;
  }

  if (ownsAllArp && seasonEndsBeforeAllArp) {
    const left = battlePassRemainingMs(siteState.battlePass);
    const todo: ActionTodo = {
      tone: 'warn',
      text: `Claim ${countLabel} now — Battle Pass ends before All-ARP% can be equipped`,
      claimBattlePass: shouldShowClaimAll,
      urgency: actionUrgency({
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        ...(typeof left === 'number' && { deadlineMs: left }),
        arp: readyArp,
        chain: 'before',
      }),
    };
    if (left !== undefined) {
      todo.reasons = [{ text: `Ends in ${formatMs(left)}` }];
    }
    todos.push(todo);
    return;
  }

  if (ownsAllArp) {
    pushHeldArpBattlePassTodos(
      todos,
      siteState,
      readyArp,
      afterAllArpEquipped,
      allArpReadyAtMs,
    );
    return;
  }

  todos.push({
    text: `Claim ${countLabel}`,
    claimBattlePass: shouldShowClaimAll,
    urgency: {
      kind: 'action',
      readyAtMs: 0,
      durationMs: 0,
      arp: readyArp,
      chain: 'before',
    },
  });
}

function comboBonusForActivity(combo: LoadoutLike, key: ActivityKey): number {
  if (!combo) {
    return 0;
  }
  switch (key) {
    case 'steamQuests': {
      return combo.steamQuestsFlat;
    }
    case 'watchTwitch': {
      return combo.watchTwitchFlat;
    }
    case 'discordPoll': {
      return combo.discordPollFlat;
    }
    case 'timeOnSite': {
      return loadoutStats(combo)?.timeOnSiteFlat ?? 0;
    }
    default: {
      return 0;
    }
  }
}

function twitchActivityLabel(options: {
  beforeSwap: boolean;
  utcDeadline: boolean;
  phase: ActivityPhase;
  waitMs: number;
  watchRemainingMs: number;
  utcDailyEndBufferMs: number;
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
    )
  ) {
    return 'Watch Twitch now';
  }
  if (options.utcDeadline) {
    return `Watch Twitch (${utcResetDeadlineLabel()})`;
  }
  return `Watch Twitch${options.beforeSwap ? ' before swapping' : ''}`;
}

function twitchArpReason(options: {
  phase: ActivityPhase;
  waitMs: number;
  watchRemainingMs: number;
  allArpPct: number;
  upcomingReset?: 'utc' | 'steam';
}): ActionTodoReason | undefined {
  const arp = Math.round(
    (options.watchRemainingMs / 60_000) * (1 + options.allArpPct),
  );
  if (arp <= 0) {
    return undefined;
  }
  if (options.upcomingReset === 'utc') {
    return { text: `+${arp} ARP after 00:00 UTC` };
  }
  if (options.phase === 'after' && options.waitMs > 0) {
    const left = msAfterUnlockBeforeReset(options.waitMs);
    if (left > 0) {
      return { text: `+${arp} ARP (fits in ${formatMs(left)} before reset)` };
    }
  }
  return { text: `+${arp} ARP` };
}

function discordPollActivityLabel(
  bonus: number,
  options: {
    beforeSwap: boolean;
    phase: ActivityPhase;
    waitMs: number;
  },
): string {
  const bonusPart = bonus > 0 ? ` (+${bonus} equipped bonus)` : '';
  const nextPost = formatMs(msUntilNextDiscordPollPost());
  if (options.phase === 'after' && options.waitMs > 0) {
    return `Vote Discord Poll after unlock (${formatMs(options.waitMs)} wait, next post in ${nextPost})${bonusPart}`;
  }
  if (options.phase === 'before') {
    return `Vote Discord Poll now — next post in ${nextPost}${bonusPart}`;
  }
  return `Vote Discord Poll${options.beforeSwap ? ' before swapping' : ''}${bonusPart}`;
}

function steamQuestCountLabel(count: number): string {
  if (count === 1) {
    return '1 Steam Quest';
  }
  if (count > 1) {
    return `${count} Steam Quests`;
  }
  return 'Steam Quest(s)';
}

function steamQuestsActivityLabel(
  bonus: number,
  options: {
    beforeSwap: boolean;
    pendingCount: number;
  },
): string {
  const bonusPart = bonus > 0 ? ` (+${bonus} equipped bonus)` : '';
  const beforePart = options.beforeSwap ? ' before swapping' : '';
  return `Complete ${steamQuestCountLabel(options.pendingCount)}${beforePart}${bonusPart}`;
}

function dailyQuestCountLabel(
  pending: ReadonlyArray<{ kind: 'daily' | 'weekend' }>,
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
      : `${count} Daily and Weekend Quests`;
  }
  if (weekend > 0) {
    return count === 1 ? 'Weekend Quest' : `${count} Weekend Quests`;
  }
  return count === 1 ? 'Daily Quest' : `${count} Daily Quests`;
}

function dailyQuestsActivityLabel(
  pending: ReadonlyArray<{ kind: 'daily' | 'weekend' }>,
  options: {
    beforeSwap: boolean;
    utcDeadline: boolean;
  },
): string {
  const beforePart = options.beforeSwap ? ' before swapping' : '';
  const questsName = dailyQuestCountLabel(pending);
  if (options.utcDeadline) {
    return `Complete ${questsName} (${utcResetDeadlineLabel()})`;
  }
  return `Complete ${questsName}${beforePart}`;
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
    steamQuestCount?: number;
    dailyQuestPending?: ReadonlyArray<{ kind: 'daily' | 'weekend' }>;
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
      });
    }
    case 'discordPoll': {
      return discordPollActivityLabel(bonus, options);
    }
    case 'timeOnSite': {
      // Only remind when this step follows an equip onto a ToS loadout.
      // Skip when ToS is already on, not planned, or slots are locked (phase
      // "other" / before) — otherwise it implies a preceding swap you can't do.
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

function msAfterUnlockBeforeReset(waitMs: number, now = new Date()): number {
  return Math.max(0, msUntilUtcMidnight(now) - waitMs);
}

function canFinishTwitchAfterUnlock(
  waitMs: number,
  watchRemainingMs: number,
  bufferMs: number,
  now = new Date(),
): boolean {
  return (
    Math.max(0, msUntilUtcMidnight(now) - waitMs - bufferMs) >= watchRemainingMs
  );
}

/**
 * ARP from one UTC-reset activity on a loadout, including All-ARP%.
 * Used to decide whether waiting for a swap is actually better for that task.
 */
function activityWindowArp(
  combo: LoadoutLike,
  key: ActivityKey,
  siteState?: SiteState,
  options?: { fullDay?: boolean },
): number {
  const stats = loadoutStats(combo);
  const allArpPct = stats?.allArpPct ?? combo?.allArpPct ?? 0;
  let base = 0;
  switch (key) {
    case 'watchTwitch': {
      base =
        siteState === undefined || options?.fullDay === true
          ? (siteState?.watchTwitch?.capArp ??
              BASE_ACTIVITY.watchTwitchBasePerDay) +
            (stats?.watchTwitchFlat ?? comboBonusForActivity(combo, key))
          : twitchWatchRemainingMs(
              siteState,
              stats?.watchTwitchFlat ?? comboBonusForActivity(combo, key),
            ) / 60_000;
      break;
    }
    case 'dailyQuests': {
      base = BASE_ACTIVITY.dailyQuestBase;
      break;
    }
    case 'timeOnSite': {
      base = BASE_ACTIVITY.timeOnSiteBasePerDay + (stats?.timeOnSiteFlat ?? 0);
      break;
    }
    case 'steamQuests': {
      const remaining = siteState
        ? remainingSteamQuestRewards(siteState)
        : [...BASE_ACTIVITY.steamQuestBases];
      const bases =
        options?.fullDay === true
          ? [...BASE_ACTIVITY.steamQuestBases]
          : remaining;
      const flat = stats?.steamQuestsFlat ?? comboBonusForActivity(combo, key);
      return (
        (bases.reduce((sum, value) => sum + value, 0) + flat * bases.length) *
        (1 + allArpPct)
      );
    }
    case 'discordPoll': {
      base = BASE_ACTIVITY.discordPollBase;
      break;
    }
    default: {
      break;
    }
  }
  const flat =
    key === 'watchTwitch' || key === 'timeOnSite'
      ? 0
      : comboBonusForActivity(combo, key);
  return (base + flat) * (1 + allArpPct);
}

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
  } = options;
  const currentArp = activityWindowArp(current, key, siteState);
  const afterNowArp = activityWindowArp(afterNow ?? current, key, siteState);
  // Filling a free slot (or replacing a piece that doesn't help this activity)
  // doesn't cost ARP — start the 24h cooldown first, then do the daily.
  if (needsSwap && hasImmediateEquip && afterNowArp >= currentArp) {
    return 'afterNow';
  }
  const futureWaitMs = plannedWear?.waitMs ?? waitMs;
  const futureStats = plannedWear?.stats ?? best;
  const futureArp = activityWindowArp(futureStats, key, siteState);
  const durationMs = activityDurationMs(key, watchRemainingMs);
  const isFitsAfterFuture =
    key === 'watchTwitch'
      ? canFinishTwitchAfterUnlock(futureWaitMs, watchRemainingMs, cutoffMs)
      : canCompleteInWearWindow(
          0,
          msUntilUtcMidnight(),
          futureWaitMs,
          durationMs,
        );
  // Wait for All-ARP% (deferred or recommended) when that lock still covers
  // this UTC day — repeating dailies must not beat a later one-shot multiplier.
  if (isFitsAfterFuture && futureArp > currentArp) {
    return 'after';
  }
  return 'before';
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
    });
  }

  if (
    key === 'steamQuests' &&
    plannedWear &&
    activityWindowArp(plannedWear.stats, key, siteState) >
      activityWindowArp(current, key, siteState) &&
    canCompleteInWearWindow(
      0,
      msUntilNextSteamQuestWeek(),
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

  // Must do today with whatever is equipped — can't wait for the swap.
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
  if (phase === 'afterNow') {
    return afterNow?.allArpPct ?? current?.allArpPct ?? 0;
  }
  return current?.allArpPct ?? 0;
}

function bonusForActivityPhase(
  phase: ActivityPhase,
  currentBonus: number,
  bestBonus: number,
  afterNowBonus = 0,
): number {
  if (phase === 'after') {
    return bestBonus;
  }
  if (phase === 'afterNow') {
    return afterNowBonus;
  }
  if (phase === 'before') {
    return currentBonus;
  }
  return 0;
}

function activityTodoArp(options: {
  key: ActivityKey;
  bonusForText: number;
  allArpPct: number;
  twitchArp: number;
}): number {
  const { key, bonusForText, allArpPct, twitchArp } = options;
  if (key === 'watchTwitch') {
    return twitchArp;
  }
  if (key === 'timeOnSite') {
    return Math.round(
      (BASE_ACTIVITY.timeOnSiteBasePerDay + bonusForText) * (1 + allArpPct),
    );
  }
  return bonusForText;
}

function activityTodoUrgency(options: {
  key: ActivityKey;
  phase: ActivityPhase;
  waitMs: number;
  watchRemainingMs: number;
  isUtcDaily: boolean;
  bonusForText: number;
  allArpPct: number;
}): ActionTodoUrgency {
  const {
    key,
    phase,
    waitMs,
    watchRemainingMs,
    isUtcDaily,
    bonusForText,
    allArpPct,
  } = options;
  const readyAtMs = phase === 'after' ? waitMs : 0;
  const twitchArp =
    key === 'watchTwitch'
      ? Math.round((Math.max(0, watchRemainingMs) / 60_000) * (1 + allArpPct))
      : 0;
  return actionUrgency({
    kind: readyAtMs > 0 ? 'schedule' : 'action',
    readyAtMs,
    durationMs: activityDurationMs(key, watchRemainingMs),
    ...(isUtcDaily && { deadlineMs: msUntilUtcMidnight() }),
    arp: activityTodoArp({
      key,
      bonusForText,
      allArpPct,
      twitchArp,
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
  if (reasons.length === 0) {
    return { count: pending.length };
  }
  return { count: pending.length, reasons };
}

function dailyQuestsTodoExtras(siteState: SiteState): {
  pending: ReturnType<typeof remainingDailyQuestRows>;
  reasons?: ActionTodoReason[];
} {
  const pending = remainingDailyQuestRows(siteState);
  const pendingNames = pending
    .map((quest) => quest.name)
    .filter((name) => name.length > 0);
  if (pendingNames.length === 0) {
    return { pending };
  }
  return { pending };
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
  } = options;
  const reasons: ActionTodoReason[] = [];
  if (key === 'watchTwitch') {
    const twitchReason = twitchArpReason({
      phase,
      waitMs,
      watchRemainingMs,
      allArpPct,
      ...(upcomingReset && { upcomingReset }),
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
    }),
  };

  const reasons = activityTodoReasons({
    key,
    phase,
    waitMs,
    watchRemainingMs,
    allArpPct,
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
    msUntilUtcMidnight() <= 2 * 3_600_000;
  if (isUtcUrgent) {
    todo.tone = 'warn';
  }

  return todo;
}

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
  if (/Watch Twitch/i.test(todo.text)) {
    return 1;
  }
  return 2;
}

function sortTodosByUtcDeadline(items: ActionTodo[]): ActionTodo[] {
  return items.toSorted((left, right) => {
    const leftUrgent = /00:00 UTC/i.test(left.text) ? 0 : 1;
    const rightUrgent = /00:00 UTC/i.test(right.text) ? 0 : 1;
    if (leftUrgent !== rightUrgent) {
      return leftUrgent - rightUrgent;
    }
    return utcResetTodoRank(left) - utcResetTodoRank(right);
  });
}

/**
 * Place due activities before or after the recommended swap.
 * Do current-loadout strengths first when a swap would drop that activity's
 * ARP; filling a free slot (or replacing a piece that doesn't help) goes
 * first so the 24h cooldown starts now. After unlock, do activities the new
 * set is better for. UTC-deadline dailies that expire before slots unlock
 * must be done now even if the bonus isn't optimal.
 */
function upcomingResetAtMs(
  key: ActivityKey,
  siteState: SiteState,
  plannedWear: PlannedWear | undefined,
  isTodayDue: boolean,
): number | undefined {
  if (!plannedWear || isTodayDue) {
    return undefined;
  }
  if (key === 'steamQuests') {
    if (isActivityPending(siteState.caps, 'steamQuests')) {
      return undefined;
    }
    const monday = msUntilNextSteamQuestWeek();
    if (
      !canCompleteInWearWindow(
        monday,
        monday + STEAM_WEEK_MS,
        plannedWear.waitMs,
        0,
      )
    ) {
      return undefined;
    }
    return monday;
  }
  if (!isUtcDailyActivity(key)) {
    return undefined;
  }
  const midnight = msUntilUtcMidnight();
  const duration =
    key === 'watchTwitch'
      ? twitchFullDayMs(plannedWear.stats, siteState)
      : activityDurationMs(key, 0);
  if (
    !canCompleteInWearWindow(
      midnight,
      midnight + 86_400_000,
      plannedWear.waitMs,
      duration,
    )
  ) {
    return undefined;
  }
  return midnight;
}

function waitMsForActivityPhase(
  phase: ActivityPhase,
  delayWaitMs: number,
  waitMs: number,
): number {
  if (phase === 'afterNow') {
    return 0;
  }
  if (phase === 'after') {
    return delayWaitMs;
  }
  return waitMs;
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
  } = options;
  const phase = resolveActivityPhase({
    key: rule.key,
    needsSwap,
    expiresBeforeUnlock: isExpiresBeforeUnlock,
    currentBonus,
    bestBonus,
    afterNowBonus,
    waitMs: delayWaitMs,
    canEquipBeforeReset: delayWaitMs <= msUntilUtcMidnight(),
    isUtcDaily,
    current,
    best,
    afterNow,
    hasImmediateEquip,
    watchRemainingMs: watchAfterMs,
    siteState,
    plannedWear,
    utcDailyEndBufferMs: cutoffMs,
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
  if (rule.key === 'watchTwitch') {
    return (
      watchRemainingMs > 0 && isActivityAvailable(siteState.caps, 'watchTwitch')
    );
  }
  return rule.isDue(siteState.caps);
}

function buildSequencedActivityTodos(
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  options: {
    needsSwap: boolean;
    waitMs: number;
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
  const { needsSwap, waitMs: fallbackWaitMs } = options;
  const current = result.current;
  const best = result.best;
  const plan = best
    ? planLoadoutChanges(best.artifacts, current, settings, result.slotLocks)
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
      isUtcDaily && delayWaitMs > msUntilUtcMidnight() && delayWaitMs > 0;

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
      });
    }
  }

  pushCommunityEventTodo(
    buckets.other,
    siteState,
    settings,
    current?.allArpPct ?? 0,
  );

  return {
    beforeSwap: sortTodosByUtcDeadline(buckets.beforeSwap),
    afterNow: sortTodosByUtcDeadline(buckets.afterNow),
    afterSwap: sortTodosByUtcDeadline(buckets.afterSwap),
    other: sortTodosByUtcDeadline(buckets.other),
  };
}

function flatBonusReason(
  amount: number,
  label: string,
  waitMs: number,
): string {
  const isAfterUnlock = waitMs > msUntilUtcMidnight();
  return isAfterUnlock
    ? `+${amount} ${label} after unlock`
    : `+${amount} ${label}`;
}

function pushAllArpEquipReasons(
  reasons: ActionTodoReason[],
  allArpPct: number,
  siteState: SiteState,
): void {
  if (allArpPct <= 0) {
    return;
  }

  const event = siteState.communityEvent;
  if (!event?.isLive || !canEarnCommunityEventArp(event)) {
    return;
  }
  const pending = breakDownCommunityEventPending(event);
  if (pending.waitingPersonalArp > 0) {
    reasons.push({
      text: `All-ARP% before personal Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp, allArpPct)})`,
    });
  } else if (pending.waitingCommunityArp > 0) {
    reasons.push({
      text: `All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp, allArpPct)})`,
    });
  }
  // Battle Pass claim is its own follow-up action item — don't restate it here.
}

function pushFlatEquipReason(
  reasons: ActionTodoReason[],
  amount: number,
  waitMs: number,
  isDueNow: boolean,
  isDueAfterReset: boolean,
  nowLabel: string,
  laterLabel: string,
): void {
  if (amount <= 0 || (!isDueNow && !isDueAfterReset)) {
    return;
  }
  reasons.push({
    text: flatBonusReason(amount, isDueNow ? nowLabel : laterLabel, waitMs),
  });
}

function collectEquipReasons(
  siteState: SiteState,
  waitMs: number,
  stepArtifacts: OwnedArtifact[],
): ActionTodoReason[] {
  const reasons: ActionTodoReason[] = [];
  const caps = siteState.caps;
  const stats = activityStatsForArtifacts(stepArtifacts);

  pushAllArpEquipReasons(reasons, stats.allArpPct, siteState);

  // Only cite discount when it is vault-priority. Weaker pieces like
  // Mysterious Text Decipher (2%) are not a reason to equip / lock a slot.
  if (stats.marketDiscountPct >= VAULT_PRIORITY_DISCOUNT_PCT) {
    reasons.push({
      text: `${Math.round(stats.marketDiscountPct * 100)}% Game Vault / marketplace discount before buying`,
    });
  }

  const isNextUtcResetInLock = isResetInWearWindow(
    msUntilUtcMidnight(),
    waitMs,
  );
  const isSteamDueNow = isActivityPending(caps, 'steamQuests');
  pushFlatEquipReason(
    reasons,
    stats.steamQuestsFlat,
    waitMs,
    isSteamDueNow,
    isResetInWearWindow(msUntilNextSteamQuestWeek(), waitMs),
    'Steam Quests',
    'Steam Quests after Monday reset',
  );
  pushFlatEquipReason(
    reasons,
    stats.watchTwitchFlat,
    waitMs,
    isActivityAvailable(caps, 'watchTwitch'),
    isNextUtcResetInLock,
    'Watch Twitch cap',
    'Watch Twitch cap after 00:00 UTC',
  );
  if (stats.discordPollFlat > 0 && isActivityPending(caps, 'discordPoll')) {
    reasons.push({
      text: flatBonusReason(stats.discordPollFlat, 'Discord Poll', waitMs),
    });
  }
  // Auto-claims on visit; ARP log marks today capped. Count the next day.
  if (stats.dailyCalendarFlat > 0) {
    reasons.push({
      text: flatBonusReason(
        stats.dailyCalendarFlat,
        "Tomorrow's Daily Calendar ",
        waitMs,
      ),
    });
  }
  if (waitMs > 0 && isArtifactsShowroomPage()) {
    reasons.push({
      text: 'Still stuck after Refresh? Upgrade a maxed artifact manually (Warrior Script) — 0 fragments',
    });
  }

  return reasons;
}

function comboArtifactsByIds(
  combo: NonNullable<OptimizerResult['best']>,
  ids: ReadonlySet<number>,
): OwnedArtifact[] {
  return combo.artifacts.filter((artifact) => ids.has(artifact.instanceId));
}

function buildEquipTodo(options: {
  headline: string;
  loadout: string;
  reasons: ActionTodoReason[];
  tone?: ActionTone;
  urgency?: ActionTodoUrgency;
}): ActionTodo {
  const { headline, loadout, reasons, tone, urgency } = options;
  // Keep loadout on the dedicated field — renderActionTodoBody prints it as its
  // own line; embedding it in `text` duplicated the artifact names.
  const todo: ActionTodo = {
    text: headline,
    loadout,
    urgency: urgency ?? {
      kind: 'action',
      readyAtMs: 0,
      durationMs: 0,
      chain: 'equip',
    },
  };
  if (reasons.length > 0) {
    todo.reasons = reasons;
  }
  if (tone) {
    todo.tone = tone;
  }
  return todo;
}

function deferredSteamTodo(
  deferred: NonNullable<OptimizerResult['deferredSteam']>,
  siteState: SiteState,
): ActionTodo {
  const { waitMs, artifacts } = deferred;
  const headline =
    waitMs > 0
      ? `Equip Steam Quests set in ${formatMs(waitMs)}`
      : 'Equip Steam Quests set now';
  return buildEquipTodo({
    headline,
    loadout: loadoutLabel(artifacts),
    reasons: collectEquipReasons(siteState, waitMs, artifacts),
    urgency: actionUrgency({
      kind: waitMs > 0 ? 'schedule' : 'action',
      readyAtMs: waitMs,
      durationMs: 0,
      deadlineMs: msUntilNextSteamQuestWeek(),
      chain: 'equip',
    }),
  });
}

function deferredAllArpTodo(
  deferred: NonNullable<OptimizerResult['deferredAllArp']>,
): ActionTodo {
  const { waitMs, artifacts, unlock } = deferred;
  const parts: string[] = [];
  if (unlock.targetHours !== undefined) {
    parts.push(`Before ${unlock.targetHours.toLocaleString()}h`);
  }
  if (unlock.etaMs !== undefined) {
    parts.push(`ETA ${formatCommunityEta(unlock.etaMs)}`);
  }
  parts.push(formatCommunityEventArp(unlock.arpReward));
  return buildEquipTodo({
    headline: `Equip All-ARP% in ${formatMs(waitMs)}`,
    loadout: loadoutLabel(artifacts),
    reasons: [{ text: parts.join(' · ') }],
    urgency: actionUrgency({
      kind: 'schedule',
      readyAtMs: waitMs,
      durationMs: 0,
      ...(typeof unlock.etaMs === 'number' && { deadlineMs: unlock.etaMs }),
      arp: unlock.arpReward,
      chain: 'equip',
    }),
  });
}

function allArpArtifactsFromResult(
  result: OptimizerResult,
): OwnedArtifact[] | undefined {
  const loadout = result.allArpLoadout;
  if (loadout && loadout.artifacts.length > 0 && loadout.allArpPct > 0) {
    return loadout.artifacts;
  }
  const deferred = result.deferredAllArp?.artifacts;
  if (deferred && deferred.length > 0) {
    return deferred;
  }
  return undefined;
}

function battlePassAllArpEquipWaitMs(options: {
  result: OptimizerResult;
  plan: LoadoutChangePlan | undefined;
  isNeedsSwap: boolean;
  settings: ArtifactOptimizerSettings;
  allArpArtifacts: OwnedArtifact[];
}): number {
  const { result, plan, isNeedsSwap, settings, allArpArtifacts } = options;
  const best = result.best;
  const willWearOtherSetFirst =
    isNeedsSwap &&
    best !== undefined &&
    best.allArpPct <= 0 &&
    !isSameLoadout(best.artifacts, allArpArtifacts);
  if (willWearOtherSetFirst) {
    return (plan?.waitMs ?? 0) + COOLDOWN_MS;
  }

  const wearing = result.current?.artifacts;
  const targetIds = new Set(
    allArpArtifacts.map((artifact) => artifact.instanceId),
  );
  let waitMs = 0;
  for (const position of [1, 2, 3] as const) {
    const equipped = wearing?.find(
      (artifact) => artifact.equippedPosition === position,
    );
    if (equipped && targetIds.has(equipped.instanceId)) {
      continue;
    }
    waitMs = Math.max(
      waitMs,
      showroomCooldownRemainingMs(settings, position, {
        ...(result.slotLocks && { slotLocks: result.slotLocks }),
        ...(typeof equipped?.slotLocked === 'boolean' && {
          equippedSlotLocked: equipped.slotLocked,
        }),
      }),
    );
  }
  return waitMs;
}

function battlePassAllArpEquipTodo(options: {
  result: OptimizerResult;
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  plan: LoadoutChangePlan | undefined;
  isNeedsSwap: boolean;
}): ActionTodo | undefined {
  const artifacts = allArpArtifactsFromResult(options.result);
  const waitMs = battlePassAllArpEquipWaitMs({
    result: options.result,
    plan: options.plan,
    isNeedsSwap: options.isNeedsSwap,
    settings: options.settings,
    allArpArtifacts: artifacts ?? [],
  });
  const arpReady = battlePassClaimableArp(options.siteState.battlePass);
  const headline =
    waitMs > 0 ? `Equip All-ARP% in ${formatMs(waitMs)}` : 'Equip All-ARP%';
  return buildEquipTodo({
    headline,
    loadout: artifacts ? loadoutLabel(artifacts) : 'All-ARP% set',
    reasons: [],
    urgency: actionUrgency({
      kind: waitMs > 0 ? 'schedule' : 'action',
      readyAtMs: waitMs,
      durationMs: 0,
      ...(arpReady > 0 && { arp: arpReady }),
      chain: 'equip',
    }),
  });
}

function battlePassAllArpSchedule(options: {
  result: OptimizerResult;
  plan: LoadoutChangePlan | undefined;
  isNeedsSwap: boolean;
  settings: ArtifactOptimizerSettings;
  waitMs: number;
  hasPlannedAllArp: boolean;
  shouldDeferBattlePassClaim: boolean;
}): {
  hasScheduledAllArp: boolean;
  readyAtMs: number;
  shouldAddEquipTodo: boolean;
} {
  const deferred = options.result.deferredAllArp;
  const artifacts = allArpArtifactsFromResult(options.result);
  const shouldAddEquipTodo =
    options.shouldDeferBattlePassClaim &&
    options.result.worthDedicatedAllArpForBattlePass === true &&
    !options.hasPlannedAllArp &&
    deferred === undefined &&
    (artifacts !== undefined || options.result.hasAllArpOwned === true);
  const hasScheduledAllArp =
    options.hasPlannedAllArp || deferred !== undefined || shouldAddEquipTodo;

  if (options.hasPlannedAllArp) {
    return {
      hasScheduledAllArp,
      readyAtMs: options.waitMs,
      shouldAddEquipTodo,
    };
  }
  if (deferred) {
    return {
      hasScheduledAllArp,
      readyAtMs: deferred.waitMs,
      shouldAddEquipTodo,
    };
  }
  if (shouldAddEquipTodo && artifacts) {
    return {
      hasScheduledAllArp,
      readyAtMs: battlePassAllArpEquipWaitMs({
        result: options.result,
        plan: options.plan,
        isNeedsSwap: options.isNeedsSwap,
        settings: options.settings,
        allArpArtifacts: artifacts,
      }),
      shouldAddEquipTodo,
    };
  }
  if (shouldAddEquipTodo) {
    return {
      hasScheduledAllArp,
      readyAtMs:
        (options.plan?.waitMs ?? 0) + (options.isNeedsSwap ? COOLDOWN_MS : 0),
      shouldAddEquipTodo,
    };
  }
  return { hasScheduledAllArp, readyAtMs: 0, shouldAddEquipTodo };
}

function pushCommunityAllArpGuards(
  todos: ActionTodo[],
  siteState: SiteState,
  isLocked: boolean,
  hasDeferredAllArp: boolean,
): void {
  if (hasDeferredAllArp) {
    return;
  }
  const event = siteState.communityEvent;
  if (isLocked || !event || !canEarnCommunityEventArp(event)) {
    return;
  }
  const pending = breakDownCommunityEventPending(event);
  if (pending.waitingPersonalArp > 0) {
    todos.push({
      tone: 'warn',
      text: `Equip All-ARP% before playing more Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp)} community-unlocked)`,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        arp: pending.waitingPersonalArp,
        chain: 'equip',
      },
    });
    return;
  }
  if (pending.waitingCommunityArp <= 0) {
    return;
  }
  todos.push({
    tone: 'muted',
    text: `Consider All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp)})`,
    urgency: {
      kind: 'info',
      readyAtMs: 0,
      durationMs: 0,
      arp: pending.waitingCommunityArp,
    },
  });
}

function pushAllArpGuardTodos(
  todos: ActionTodo[],
  siteState: SiteState,
  options: {
    ownsAllArp: boolean;
    hasAllArpEquipped: boolean;
    isLocked: boolean;
    deferBattlePassClaims: boolean;
    hasPlannedAllArp?: boolean;
    hasDeferredAllArp?: boolean;
    hasScheduledAllArp?: boolean;
  },
): void {
  const { ownsAllArp, hasAllArpEquipped, isLocked, deferBattlePassClaims } =
    options;
  if (!ownsAllArp || hasAllArpEquipped) {
    return;
  }
  const hasScheduledAllArp =
    options.hasScheduledAllArp === true || options.hasPlannedAllArp === true;
  if (
    deferBattlePassClaims &&
    battlePassClaimableArp(siteState.battlePass) > 0 &&
    battlePassReadyNonArp(siteState.battlePass) === 0
  ) {
    const arpReady = battlePassClaimableArp(siteState.battlePass);
    todos.push({
      kind: 'caution',
      tone: hasScheduledAllArp ? 'warn' : 'muted',
      text: `Don't claim Battle Pass ARP Boost yet (${arpReady} ready)`,
      reasons: [
        {
          text: hasScheduledAllArp
            ? 'Claim after All-ARP% is on'
            : 'More boosts may unlock — claim when All-ARP% is already on',
        },
      ],
    });
  }
  pushCommunityAllArpGuards(
    todos,
    siteState,
    isLocked,
    options.hasDeferredAllArp === true,
  );
}

function pushScheduledAllArpTodos(
  todos: ActionTodo[],
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  plan: LoadoutChangePlan | undefined,
  isNeedsSwap: boolean,
  shouldAddBattlePassEquip: boolean,
): void {
  const deferredAllArp = result.deferredAllArp;
  if (
    deferredAllArp &&
    !isSameLoadout(result.best?.artifacts ?? [], deferredAllArp.artifacts)
  ) {
    todos.push(deferredAllArpTodo(deferredAllArp));
    return;
  }
  if (deferredAllArp || !shouldAddBattlePassEquip) {
    return;
  }
  const allArpTodo = battlePassAllArpEquipTodo({
    result,
    settings,
    siteState,
    plan,
    isNeedsSwap,
  });
  if (allArpTodo) {
    todos.push(allArpTodo);
  }
}

function nowEquipHeadline(plan: LoadoutChangePlan): string {
  const nowNames = plan.now.map((change) => change.displayName).join(' + ');
  const slots = plan.now.map((change) => `slot ${change.position}`).join(', ');
  return `Equip: ${nowNames} now (${slots} free)`;
}

function buildPartialEquipTodos(
  plan: LoadoutChangePlan,
  fullLabel: string,
  nowReasons: ActionTodoReason[],
  laterReasons: ActionTodoReason[],
): ActionTodo[] | undefined {
  if (plan.now.length === 0) {
    return undefined;
  }
  const nowTodo: ActionTodo = {
    text: nowEquipHeadline(plan),
    urgency: {
      kind: 'action',
      readyAtMs: 0,
      durationMs: 0,
      chain: 'equip',
    },
  };
  if (nowReasons.length > 0) {
    nowTodo.reasons = nowReasons;
  }
  if (plan.laterNames.length > 0) {
    return [
      nowTodo,
      buildEquipTodo({
        headline: `Equip in ${formatMs(plan.waitMs)}`,
        loadout: plan.laterNames.join(' + '),
        reasons: laterReasons,
        urgency: {
          kind: 'schedule',
          readyAtMs: plan.waitMs,
          durationMs: 0,
          chain: 'equip',
        },
      }),
    ];
  }
  if (plan.lockedSlots.length > 0) {
    return [
      buildEquipTodo({
        headline: nowTodo.text,
        loadout: fullLabel,
        reasons: nowReasons,
      }),
    ];
  }
  return undefined;
}

function buildSwapEquipTodos(options: {
  best: NonNullable<OptimizerResult['best']>;
  current: OptimizerResult['current'];
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  slotLocks?: Partial<Record<1 | 2 | 3, boolean>>;
  isLocked: boolean;
  waitMs: number;
  beforeSwapCount: number;
  upgrades: UpgradeSuggestion[];
}): { immediate: ActionTodo[]; later: ActionTodo[] } {
  const {
    best,
    current,
    settings,
    siteState,
    slotLocks,
    isLocked,
    waitMs,
    beforeSwapCount,
    upgrades,
  } = options;
  const plan = planLoadoutChanges(best.artifacts, current, settings, slotLocks);
  const swapWaitMs = plan.waitMs > 0 ? plan.waitMs : waitMs;
  const laterIds = new Set(plan.later.map((change) => change.artifactId));
  const nowIds = new Set(plan.now.map((change) => change.artifactId));
  const laterArtifacts = comboArtifactsByIds(best, laterIds);
  const nowArtifacts = comboArtifactsByIds(best, nowIds);
  const laterReasons = collectEquipReasons(
    siteState,
    swapWaitMs,
    laterArtifacts.length > 0 ? laterArtifacts : best.artifacts,
  );
  const nowReasons =
    nowArtifacts.length > 0
      ? collectEquipReasons(siteState, 0, nowArtifacts)
      : laterReasons;
  const label = loadoutLabel(best.artifacts);
  const nowUpgrades = upgradeTodosFor(
    upgrades,
    new Set(plan.now.map((change) => change.artifactId)),
  );
  const laterUpgrades = upgradeTodosFor(
    upgrades,
    new Set(plan.later.map((change) => change.artifactId)),
  );
  const partial = buildPartialEquipTodos(plan, label, nowReasons, laterReasons);
  if (partial && partial.length >= 2) {
    const [nowTodo, ...rest] = partial;
    return {
      immediate: nowTodo ? [...nowUpgrades, nowTodo] : nowUpgrades,
      later: [...laterUpgrades, ...rest],
    };
  }
  if (partial) {
    return {
      immediate: [...nowUpgrades, ...partial],
      later: laterUpgrades,
    };
  }
  if (isLocked) {
    const laterLabel =
      plan.laterNames.length > 0 ? plan.laterNames.join(' + ') : label;
    return {
      immediate: nowUpgrades,
      later: [
        ...laterUpgrades,
        buildEquipTodo({
          headline: `Equip in ${formatMs(swapWaitMs)}`,
          loadout: laterLabel,
          reasons: laterReasons,
          urgency: {
            kind: 'schedule',
            readyAtMs: swapWaitMs,
            durationMs: 0,
            chain: 'equip',
          },
        }),
      ],
    };
  }
  return {
    immediate: [
      ...nowUpgrades,
      buildEquipTodo({
        headline: beforeSwapCount > 0 ? 'Then equip' : 'Equip this set',
        loadout: label,
        reasons: laterReasons,
        urgency: {
          kind: 'action',
          readyAtMs: 0,
          durationMs: 0,
          chain: 'equip',
        },
      }),
    ],
    later: laterUpgrades,
  };
}

function pushEquipPlanTodos(
  todos: ActionTodo[],
  options: {
    best: NonNullable<OptimizerResult['best']> | undefined;
    siteState: SiteState;
    isMatchingLoadout: boolean;
    isLocked: boolean;
    waitMs: number;
    hasOwnedAllArp: boolean;
    hasAllArpEquipped: boolean;
    upgrades: UpgradeSuggestion[];
  },
): void {
  const {
    best,
    siteState,
    isMatchingLoadout,
    isLocked,
    waitMs,
    hasOwnedAllArp,
    hasAllArpEquipped,
    upgrades,
  } = options;

  if (best && isMatchingLoadout) {
    const equippedIds = new Set(
      best.artifacts.map((artifact) => artifact.instanceId),
    );
    todos.push(...upgradeTodosFor(upgrades, equippedIds));
    return;
  }

  const event = siteState.communityEvent;
  const pending =
    event && canEarnCommunityEventArp(event)
      ? breakDownCommunityEventPending(event)
      : undefined;
  if (
    hasOwnedAllArp &&
    !hasAllArpEquipped &&
    isLocked &&
    pending &&
    pending.waitingPersonalArp > 0
  ) {
    todos.push({
      tone: 'warn',
      text: `Slots on cooldown (${formatMs(waitMs)} left)`,
      reasons: [
        {
          text: `Equip All-ARP% before playing Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp)} community-unlocked)`,
        },
      ],
      urgency: {
        kind: 'schedule',
        readyAtMs: waitMs,
        durationMs: 0,
        arp: pending.waitingPersonalArp,
        chain: 'equip',
      },
    });
    return;
  }
  if (
    hasOwnedAllArp &&
    !hasAllArpEquipped &&
    isLocked &&
    pending &&
    event &&
    pending.waitingCommunityArp > 0
  ) {
    todos.push({
      tone: 'muted',
      text: `Slots on cooldown (${formatMs(waitMs)} left)`,
      reasons: [
        {
          text: `Consider All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp)})`,
        },
      ],
      urgency: {
        kind: 'info',
        readyAtMs: waitMs,
        durationMs: 0,
        arp: pending.waitingCommunityArp,
      },
    });
  }
}

function upgradeTodosFor(
  upgrades: UpgradeSuggestion[],
  instanceIds: ReadonlySet<number>,
): ActionTodo[] {
  const todos: ActionTodo[] = [];
  const seenAffordable = new Set<number>();
  for (const upgrade of upgrades) {
    if (!upgrade.isAffordable) {
      break;
    }
    const instanceId = upgrade.artifact.instanceId;
    if (!instanceIds.has(instanceId)) {
      continue;
    }
    const todo: ActionTodo = {
      text: `Upgrade ${upgrade.artifact.displayName} to ${TIER_LABELS[upgrade.toTier]} (${upgrade.fragmentCost} frag)`,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        chain: 'equip',
      },
    };
    if (!seenAffordable.has(instanceId)) {
      seenAffordable.add(instanceId);
      todo.upgradeInstanceId = instanceId;
    }
    todos.push(todo);
  }
  return todos;
}

type DiscordPollSlot = 'before' | 'afterNow' | 'afterFull' | 'other';

function isImmediateDiscordUpgrade(
  plan: LoadoutChangePlan,
  best: NonNullable<OptimizerResult['best']>,
): boolean {
  return plan.now.some((change) => {
    const owned = best.artifacts.find(
      (artifact) => artifact.instanceId === change.artifactId,
    );
    const definition = owned ? getArtifactById(owned.familyId) : undefined;
    return (
      definition?.effectType === ArtifactEffectType.DiscordPoll ||
      definition?.effectType === ArtifactEffectType.AllArpPct
    );
  });
}

function discordPollSlot(options: {
  needsSwap: boolean;
  waitMs: number;
  nextPostMs: number;
  isPollBetterAfterSwap: boolean;
  canNowEquipHelpPoll: boolean;
}): DiscordPollSlot {
  const {
    needsSwap,
    waitMs,
    nextPostMs,
    isPollBetterAfterSwap,
    canNowEquipHelpPoll,
  } = options;
  if (needsSwap && isPollBetterAfterSwap && waitMs > 0 && waitMs < nextPostMs) {
    return 'afterFull';
  }
  if (needsSwap && canNowEquipHelpPoll) {
    return 'afterNow';
  }
  if (needsSwap && isPollBetterAfterSwap) {
    return 'before';
  }
  return 'other';
}

function discordPollTodoText(options: {
  slot: DiscordPollSlot;
  bonus: number;
  waitMs: number;
  nextPostMs: number;
  nowNames: string;
}): string {
  const { slot, bonus, waitMs, nextPostMs, nowNames } = options;
  const bonusPart = bonus > 0 ? ` (+${bonus} equipped bonus)` : '';
  const nextPost = formatMs(nextPostMs);
  if (slot === 'afterFull') {
    return `Vote Discord Poll after unlock (${formatMs(waitMs)} wait, next post in ${nextPost})${bonusPart}`;
  }
  if (slot === 'afterNow') {
    return `Vote Discord Poll after equipping ${nowNames}${bonusPart}`;
  }
  if (slot === 'before') {
    return `Vote Discord Poll now — next post in ${nextPost}${bonusPart}`;
  }
  if (bonus > 0) {
    return `Vote Discord Poll (+${bonus} already equipped)`;
  }
  return 'Vote Discord Poll';
}

function buildDiscordPollAction(options: {
  result: OptimizerResult;
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  needsSwap: boolean;
  waitMs: number;
}): { slot: DiscordPollSlot; todo: ActionTodo } | undefined {
  const { result, settings, siteState, needsSwap, waitMs } = options;
  if (!isActivityEnabled(settings, 'discordPoll')) {
    return undefined;
  }
  // ARP Log is the only completion signal — trust it even if caps lagged.
  if (
    hasVotedCurrentDiscordPoll(siteState.arpLog) ||
    !isActivityAvailable(siteState.caps, 'discordPoll')
  ) {
    return undefined;
  }
  const nextPostMs = msUntilNextDiscordPollPost();
  const current = result.current;
  const best = result.best;
  const isPollBetterAfterSwap =
    activityWindowArp(best, 'discordPoll') >
    activityWindowArp(current, 'discordPoll');
  const plan =
    best === undefined
      ? undefined
      : planLoadoutChanges(best.artifacts, current, settings, result.slotLocks);
  const canNowEquipHelpPoll = Boolean(
    best && plan && isImmediateDiscordUpgrade(plan, best),
  );
  const slot = discordPollSlot({
    needsSwap,
    waitMs,
    nextPostMs,
    isPollBetterAfterSwap,
    canNowEquipHelpPoll,
  });
  const currentBonus = comboBonusForActivity(current, 'discordPoll');
  const bestBonus = comboBonusForActivity(best, 'discordPoll');
  let phase: ActivityPhase = 'other';
  if (slot === 'afterFull' || slot === 'afterNow') {
    phase = 'after';
  } else if (slot === 'before') {
    phase = 'before';
  }
  const bonus =
    slot === 'other'
      ? currentBonus
      : bonusForActivityPhase(phase, currentBonus, bestBonus);
  const chain: ActionTodoChain =
    slot === 'afterFull' || slot === 'afterNow' ? 'after' : 'before';
  const todo: ActionTodo = {
    text: discordPollTodoText({
      slot,
      bonus,
      waitMs,
      nextPostMs,
      nowNames: plan?.now.map((change) => change.displayName).join(' + ') ?? '',
    }),
    urgency: actionUrgency({
      kind: 'action',
      readyAtMs: slot === 'afterFull' ? waitMs : 0,
      durationMs: 0,
      deadlineMs: nextPostMs,
      arp: BASE_ACTIVITY.discordPollBase + bonus,
      chain,
    }),
  };
  const twoHoursMs = 2 * 3_600_000;
  if (slot !== 'afterFull' && nextPostMs <= twoHoursMs) {
    todo.tone = 'warn';
  }
  return { slot, todo };
}

function discordTodoForSlot(
  discord: { slot: DiscordPollSlot; todo: ActionTodo } | undefined,
  slot: DiscordPollSlot,
): ActionTodo[] {
  return discord?.slot === slot ? [discord.todo] : [];
}

function pushRecommendedSwapTodos(options: {
  todos: ActionTodo[];
  best: NonNullable<OptimizerResult['best']>;
  current: OptimizerResult['current'];
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  slotLocks?: Partial<Record<1 | 2 | 3, boolean>>;
  isLocked: boolean;
  waitMs: number;
  sequenced: ReturnType<typeof buildSequencedActivityTodos>;
  discord: ReturnType<typeof buildDiscordPollAction>;
  upgrades: UpgradeSuggestion[];
}): void {
  const {
    todos,
    best,
    current,
    settings,
    siteState,
    slotLocks,
    isLocked,
    waitMs,
    sequenced,
    discord,
    upgrades,
  } = options;
  const swap = buildSwapEquipTodos({
    best,
    current,
    settings,
    siteState,
    isLocked,
    waitMs,
    beforeSwapCount:
      sequenced.beforeSwap.length + (discord?.slot === 'before' ? 1 : 0),
    upgrades,
    ...(slotLocks && { slotLocks }),
  });
  todos.push(
    ...swap.immediate,
    ...sequenced.afterNow,
    ...discordTodoForSlot(discord, 'afterNow'),
    ...sequenced.other,
    ...discordTodoForSlot(discord, 'other'),
    ...swap.later,
  );
}

function pushAfterSwapTodos(
  todos: ActionTodo[],
  sequenced: ReturnType<typeof buildSequencedActivityTodos>,
  discord: ReturnType<typeof buildDiscordPollAction>,
  isNeedsSwap: boolean,
): void {
  const afterSwap = [...sequenced.afterSwap];
  if (discord?.slot === 'afterFull') {
    afterSwap.unshift(discord.todo);
  }
  todos.push(...afterSwap);
  if (!isNeedsSwap) {
    todos.push(...sequenced.other, ...discordTodoForSlot(discord, 'other'));
  }
}

/**
 * Maximize ARP under cooldowns: finish current-set strengths first only when
 * the next equip would drop that activity's ARP. Filling a free slot (or
 * replacing a piece that doesn't help) happens first so the 24h cooldown
 * starts now, then activities the new set is equal/better for. Missing some
 * daily bonuses to locked slots is expected.
 */
export function buildActionPlan(
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
): ActionTodo[] {
  const todos: ActionTodo[] = [];
  const best = result.best;
  const current = result.current;
  const isMatchingLoadout = isSameLoadout(best?.artifacts, current?.artifacts);
  const isLocked = hasAnySlotOnCooldown(current, result.slotLocks);
  const plan = best
    ? planLoadoutChanges(best.artifacts, current, settings, result.slotLocks)
    : undefined;
  const waitMs =
    plan?.waitMs ?? maxSlotCooldownMs(settings, current, result.slotLocks);
  const isNeedsSwap = Boolean(best && !isMatchingLoadout);

  const hasAllArpEquipped =
    result.hasAllArpEquipped === true || (current?.allArpPct ?? 0) > 0;
  // Don't use `??` here: explicit `false` from the optimizer must not hide
  // All-ARP% on the recommended/alternative combos.
  const hasOwnedAllArp =
    result.hasAllArpOwned === true ||
    hasAllArpEquipped ||
    (result.allArpLoadout?.allArpPct ?? 0) > 0 ||
    (best?.allArpPct ?? 0) > 0 ||
    result.alternatives.some((combo) => combo.allArpPct > 0);

  const shouldDeferBattlePassClaim = result.deferBattlePassClaims === true;
  const hasPlannedAllArp = (best?.allArpPct ?? 0) > 0;
  const deferredAllArp = result.deferredAllArp;
  const allArpSchedule = battlePassAllArpSchedule({
    result,
    plan,
    isNeedsSwap,
    settings,
    waitMs,
    hasPlannedAllArp,
    shouldDeferBattlePassClaim,
  });
  const hasScheduledAllArp = allArpSchedule.hasScheduledAllArp;
  const allArpEquipReadyAtMs = allArpSchedule.readyAtMs;

  const sequenced = buildSequencedActivityTodos(result, settings, siteState, {
    needsSwap: isNeedsSwap,
    waitMs,
  });
  const discord = buildDiscordPollAction({
    result,
    settings,
    siteState,
    needsSwap: isNeedsSwap,
    waitMs,
  });

  // 1) UTC-reset work that would lose ARP if we equipped first.
  todos.push(...sequenced.beforeSwap);
  if (discord?.slot === 'before') {
    todos.push(discord.todo);
  }

  // 2) Swap (now, after those activities, or when cooldown ends).
  // Discord poll sits after immediate equip when that piece helps this poll,
  // or after full unlock when the next weekday 16:00 UTC post is still later.
  if (best && isNeedsSwap) {
    pushRecommendedSwapTodos({
      todos,
      best,
      current,
      settings,
      siteState,
      isLocked,
      waitMs,
      sequenced,
      discord,
      upgrades: result.upgrades,
      ...(result.slotLocks && { slotLocks: result.slotLocks }),
    });
  } else {
    pushEquipPlanTodos(todos, {
      best,
      siteState,
      isMatchingLoadout,
      isLocked,
      waitMs,
      hasOwnedAllArp,
      hasAllArpEquipped,
      upgrades: result.upgrades,
    });
  }

  pushAllArpGuardTodos(todos, siteState, {
    ownsAllArp: hasOwnedAllArp,
    hasAllArpEquipped,
    isLocked,
    deferBattlePassClaims: shouldDeferBattlePassClaim,
    hasPlannedAllArp,
    hasDeferredAllArp: deferredAllArp !== undefined,
    hasScheduledAllArp,
  });

  if (result.deferredSteam) {
    todos.push(deferredSteamTodo(result.deferredSteam, siteState));
  }

  // Claim BP when All-ARP% is already on, or after a swap that was planned
  // for something else (community / recommended All-ARP%). Don't swap onto
  // All-ARP% just for a boost unless that lock strictly nets more ARP.
  // Hold ARP Boosts while the season has time — All-ARP% may go on later.
  if (shouldDeferBattlePassClaim) {
    pushBattlePassTodo(todos, siteState, {
      ownsAllArp: hasOwnedAllArp,
      hasAllArpEquipped: false,
      afterAllArpEquipped: hasScheduledAllArp,
      allArpReadyAtMs: allArpEquipReadyAtMs,
    });
  } else {
    pushBattlePassTodo(todos, siteState, {
      ownsAllArp: hasOwnedAllArp,
      hasAllArpEquipped,
      seasonEndsBeforeAllArp: hasOwnedAllArp && !hasAllArpEquipped,
    });
  }

  // 3) Activities that prefer the recommended set (after swap / unlock).
  pushAfterSwapTodos(todos, sequenced, discord, isNeedsSwap);

  pushScheduledAllArpTodos(
    todos,
    result,
    settings,
    siteState,
    plan,
    isNeedsSwap,
    allArpSchedule.shouldAddEquipTodo,
  );

  if (todos.length === 0) {
    return [
      {
        tone: 'muted',
        text: 'Nothing urgent — check back after activities refresh',
        urgency: { kind: 'info', readyAtMs: 0, durationMs: 0 },
      },
    ];
  }

  const cautions = todos.filter((todo) => isCautionTodo(todo));
  const steps = sortActionTodosByUrgency(
    todos.filter((todo) => !isCautionTodo(todo)),
  );
  return [...cautions, ...steps];
}

function actionTodoToneClass(tone: ActionTodo['tone']): string {
  if (tone === 'warn') {
    return ' ao-todo-warn';
  }
  if (tone === 'muted') {
    return ' ao-todo-muted';
  }
  return '';
}

function renderActionTodoBody(todo: ActionTodo): string {
  const parts = [
    `<span class="ao-todo-headline">${wrapArtifactNames(todo.text)}</span>`,
  ];
  if (todo.loadout) {
    parts.push(
      `<span class="ao-todo-loadout">${wrapArtifactNames(todo.loadout)}</span>`,
    );
  }
  if (todo.reasons && todo.reasons.length > 0) {
    const items = todo.reasons
      .map((reason) => {
        const detail = reason.detail
          ? `<div class="ao-todo-reason-detail">${wrapArtifactNames(reason.detail)}</div>`
          : '';
        return `<li><div class="ao-todo-reason-text">${wrapArtifactNames(reason.text)}</div>${detail}</li>`;
      })
      .join('');
    parts.push(`<ul class="ao-todo-reasons">${items}</ul>`);
  }
  return parts.join('');
}

function renderTodoActionButton(
  todo: ActionTodo,
  options: { allowAccountActions?: boolean } = {},
): string {
  const areActionsEnabled = options.allowAccountActions === true;
  if (todo.upgradeInstanceId !== undefined) {
    if (!areActionsEnabled) {
      return '';
    }
    return `<button type="button" class="ao-upgrade-btn" data-id="${todo.upgradeInstanceId}">Upgrade</button>`;
  }
  if (todo.claimBattlePass === true) {
    if (!areActionsEnabled) {
      return '';
    }
    const skipArp =
      todo.claimBattlePassSkipArp === true ? ' data-skip-arp="1"' : '';
    return `<button type="button" class="ao-claim-btn"${skipArp}>${battlePassClaimButtonLabel(todo.claimBattlePassSkipArp === true)}</button>`;
  }
  if (todo.openTwitchStream === true) {
    return '<button type="button" class="ao-twitch-btn">Open stream</button>';
  }
  if (todo.openHref) {
    const visit = todo.visitInBackground === true ? ' data-visit="1"' : '';
    const label = todo.openHrefLabel ?? 'Open';
    return `<button type="button" class="ao-ach-open-btn" data-href="${escapeHtml(todo.openHref)}"${visit}>${escapeHtml(label)}</button>`;
  }
  return '';
}

function isCautionTodo(todo: ActionTodo): boolean {
  return todo.kind === 'caution';
}

/**
 * True when the next step still uses the equipped set (e.g. finish Daily
 * Quests before a later swap). The compact summary should then show current
 * stats instead of advertising the future recommended loadout.
 */
export function isKeepingCurrentLoadout(todos: ActionTodo[]): boolean {
  const firstStep = todos.find((todo) => !isCautionTodo(todo));
  return firstStep?.urgency?.chain !== 'equip';
}

export function renderActionPlanContents(
  todos: ActionTodo[],
  options: { allowAccountActions?: boolean; heading?: string } = {},
): string {
  const cautions = todos.filter((todo) => isCautionTodo(todo));
  const steps = todos.filter((todo) => !isCautionTodo(todo));
  const cautionHtml = cautions
    .map((todo) => {
      const toneClass = actionTodoToneClass(todo.tone);
      return `<div class="ao-caution${toneClass}" role="note">${renderActionTodoBody(todo)}</div>`;
    })
    .join('');
  const items = steps
    .map((todo, index) => {
      const toneClass = actionTodoToneClass(todo.tone);
      return `<li class="ao-todo-item${toneClass}"><span class="ao-todo-index">${index + 1}.</span><div class="ao-todo-text">${renderActionTodoBody(todo)}</div>${renderTodoActionButton(todo, options)}</li>`;
    })
    .join('');
  const listHtml =
    steps.length > 0 ? `<ul class="ao-todo-list">${items}</ul>` : '';
  const heading = options.heading ?? 'What to do';
  return `
    <div class="ao-heading">${escapeHtml(heading)}</div>
    ${cautionHtml}
    ${listHtml}
  `;
}

export function renderActionPlan(
  todos: ActionTodo[],
  options: { allowAccountActions?: boolean } = {},
): string {
  return `<div id="ao-action-plan">${renderActionPlanContents(todos, options)}</div>`;
}
