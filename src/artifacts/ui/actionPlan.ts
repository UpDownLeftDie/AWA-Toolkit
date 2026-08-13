import {
  ArtifactEffectType,
  BASE_ACTIVITY,
  getArtifactById,
  msUntilNextDiscordPollPost,
  TIER_LABELS,
} from "../data";
import {
  type ActivityLoadoutStats,
  activityStatsForArtifacts,
  isResetInWearWindow,
  msUntilNextSteamQuestWeek,
  type OptimizerResult,
  type UpgradeSuggestion,
} from "../optimizer";
import { isArtifactsShowroomPage, type OwnedArtifact } from "../scraper";
import type { ArtifactOptimizerSettings } from "../settings";
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
  remainingDailyQuestRows,
  remainingSteamQuestRows,
  type SiteState,
  twitchWatchRemainingMs,
} from "../siteState";
import { shouldShowBattlePassClaimAll } from "../siteState/battlePass";
import { describeWaitingCommunityArpLine } from "../siteState/communityEvent";
import { STEAM_LIBRARY_PENDING_HINT } from "../steamApp";
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
} from "./loadoutPlan";

export type ActionTone = "default" | "muted" | "warn";

/**
 * How a step competes in the final "What to do" order.
 *
 * Sort: kind → readyAt → chain → duration → deadline slack → ARP.
 * Instant ready actions (Discord) beat long ready actions (Twitch); scheduled
 * equips beat informational waiting (community unlock ETA).
 */
export type ActionTodoUrgencyKind = "action" | "schedule" | "info";

/**
 * Soft dependency relative to an equip/swap step.
 */
export type ActionTodoChain = "before" | "equip" | "after";

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
  kind?: "caution";
  /**
  Affordable META upgrade — renders a confirm+Upgrade button on this step.
  */
  upgradeInstanceId?: number;
  /**
  Ready Battle Pass rewards — renders a Claim all button on this step.
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
  Final list order — phases still decide wording / swap sequencing metadata.
  */
  urgency?: ActionTodoUrgency;
}

type ActivityPhase = "before" | "afterNow" | "after" | "other";

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
  const leftChain = CHAIN_RANK[left.chain ?? "before"];
  const rightChain = CHAIN_RANK[right.chain ?? "before"];
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
  if (todo.tone === "muted" && !todo.loadout) {
    return { kind: "info", readyAtMs: 0, durationMs: 0 };
  }
  return { kind: "action", readyAtMs: 0, durationMs: 0 };
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
  if (phase === "afterNow") {
    return "equip";
  }
  if (phase === "after") {
    return "after";
  }
  return "before";
}

type ActivityTodoRule = {
  key: ActivityKey;
  isDue: (caps: SiteState["caps"]) => boolean;
};

const ACTIVITY_TODO_RULES: readonly ActivityTodoRule[] = [
  {
    key: "steamQuests",
    isDue: (caps) => isActivityPending(caps, "steamQuests"),
  },
  {
    key: "dailyQuests",
    isDue: (caps) => isActivityPending(caps, "dailyQuests"),
  },
  {
    key: "watchTwitch",
    isDue: (caps) => isActivityAvailable(caps, "watchTwitch"),
  },
  {
    key: "timeOnSite",
    isDue: (caps) => isActivityAvailable(caps, "timeOnSite"),
  },
];

function isActivityEnabled(
  settings: ArtifactOptimizerSettings,
  key: ActivityKey,
): boolean {
  return settings.activities[key]?.enabled;
}

function pushCommunityEventTodo(
  todos: ActionTodo[],
  siteState: SiteState,
  settings: ArtifactOptimizerSettings,
  allArpPct = 0,
): void {
  const event = siteState.communityEvent;
  if (
    !isActivityEnabled(settings, "steamCommunityEvent") ||
    !event?.isLive ||
    event.pendingArp <= 0 ||
    !canEarnCommunityEventArp(event)
  ) {
    return;
  }
  const pending = breakDownCommunityEventPending(event);
  const etaMs = estimateNextCommunityUnlock(event)?.etaMs;
  const urgency = actionUrgency(
    pending.waitingPersonalArp > 0
      ? {
          kind: "action",
          readyAtMs: 0,
          durationMs: 0,
          arp: pending.waitingPersonalArp,
          chain: "before",
        }
      : {
          kind: "info",
          readyAtMs: etaMs ?? 0,
          durationMs: 0,
          ...(typeof etaMs === "number" && { deadlineMs: etaMs }),
          arp:
            pending.waitingCommunityArp +
            pending.imminentArp +
            pending.waitingPersonalArp,
        },
  );
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
    urgency,
  };
  if (reasons.length > 0) {
    todo.reasons = reasons;
  }
  todos.push(todo);
}

function battlePassClaimCountLabel(readyAll: number, readyArp: number): string {
  if (readyArp <= 0) {
    return readyAll === 1
      ? "1 Battle Pass reward"
      : `${readyAll} Battle Pass rewards`;
  }
  if (readyAll === readyArp) {
    return readyArp === 1
      ? "1 Battle Pass ARP Boost"
      : `${readyArp} Battle Pass ARP Boosts`;
  }
  const boosts = readyArp === 1 ? "1 ARP Boost" : `${readyArp} ARP Boosts`;
  return `${readyAll} Battle Pass rewards (${boosts})`;
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
        kind: "action",
        readyAtMs: 0,
        durationMs: 0,
        chain: "before",
      },
    });
    return;
  }

  if (hasAllArpEquipped) {
    todos.push({
      text: `Claim ${countLabel} now — All-ARP% is equipped`,
      claimBattlePass: shouldShowClaimAll,
      urgency: {
        kind: "action",
        readyAtMs: 0,
        durationMs: 0,
        arp: readyArp,
        chain: "before",
      },
    });
    return;
  }

  if (ownsAllArp && seasonEndsBeforeAllArp) {
    const left = battlePassRemainingMs(siteState.battlePass);
    const todo: ActionTodo = {
      tone: "warn",
      text: `Claim ${countLabel} now — Battle Pass ends before All-ARP% can be equipped`,
      claimBattlePass: shouldShowClaimAll,
      urgency: actionUrgency({
        kind: "action",
        readyAtMs: 0,
        durationMs: 0,
        ...(typeof left === "number" && { deadlineMs: left }),
        arp: readyArp,
        chain: "before",
      }),
    };
    if (left !== undefined) {
      todo.reasons = [{ text: `Ends in ${formatMs(left)}` }];
    }
    todos.push(todo);
    return;
  }

  if (ownsAllArp) {
    const nonArp = battlePassReadyNonArp(siteState.battlePass);
    if (nonArp > 0) {
      todos.push({
        text: `Claim ${battlePassClaimCountLabel(nonArp, 0)} now — leave ARP Boosts until All-ARP% is on`,
        claimBattlePass: true,
        claimBattlePassSkipArp: true,
        urgency: {
          kind: "action",
          readyAtMs: 0,
          durationMs: 0,
          chain: "before",
        },
      });
    }
    if (afterAllArpEquipped) {
      todos.push({
        text: `Claim ${battlePassClaimCountLabel(readyArp, readyArp)} after All-ARP% is on`,
        urgency: {
          kind: "schedule",
          readyAtMs: 0,
          durationMs: 0,
          arp: readyArp,
          chain: "after",
        },
      });
    }
    return;
  }

  todos.push({
    text: `Claim ${countLabel}`,
    claimBattlePass: shouldShowClaimAll,
    urgency: {
      kind: "action",
      readyAtMs: 0,
      durationMs: 0,
      arp: readyArp,
      chain: "before",
    },
  });
}

function comboBonusForActivity(
  combo:
    ActivityLoadoutStats | OptimizerResult["best"] | OptimizerResult["current"],
  key: ActivityKey,
): number {
  if (!combo) {
    return 0;
  }
  switch (key) {
    case "steamQuests": {
      return combo.steamQuestsFlat;
    }
    case "watchTwitch": {
      return combo.watchTwitchFlat;
    }
    case "discordPoll": {
      return combo.discordPollFlat;
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
}): string {
  if (options.phase === "after" || options.phase === "afterNow") {
    return "Watch Twitch";
  }
  if (
    options.phase === "before" &&
    options.waitMs > 0 &&
    !canFinishTwitchAfterUnlock(options.waitMs, options.watchRemainingMs)
  ) {
    return "Watch Twitch now";
  }
  if (options.utcDeadline) {
    return `Watch Twitch (${utcResetDeadlineLabel()})`;
  }
  return `Watch Twitch${options.beforeSwap ? " before swapping" : ""}`;
}

function twitchArpReason(options: {
  phase: ActivityPhase;
  waitMs: number;
  watchRemainingMs: number;
  allArpPct: number;
}): ActionTodoReason | undefined {
  const arp = Math.round(
    (options.watchRemainingMs / 60_000) * (1 + options.allArpPct),
  );
  if (arp <= 0) {
    return undefined;
  }
  if (options.phase === "after" && options.waitMs > 0) {
    const left = formatMs(msAfterUnlockBeforeReset(options.waitMs));
    return { text: `+${arp} ARP (fits in ${left} before reset)` };
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
  const bonusPart = bonus > 0 ? ` (+${bonus} equipped bonus)` : "";
  const nextPost = formatMs(msUntilNextDiscordPollPost());
  if (options.phase === "after" && options.waitMs > 0) {
    return `Vote Discord Poll after unlock (${formatMs(options.waitMs)} wait, next post in ${nextPost})${bonusPart}`;
  }
  if (options.phase === "before") {
    return `Vote Discord Poll now — next post in ${nextPost}${bonusPart}`;
  }
  return `Vote Discord Poll${options.beforeSwap ? " before swapping" : ""}${bonusPart}`;
}

function steamQuestCountLabel(count: number): string {
  if (count === 1) {
    return "1 Steam Quest";
  }
  if (count > 1) {
    return `${count} Steam Quests`;
  }
  return "Steam Quest(s)";
}

function steamQuestsActivityLabel(
  bonus: number,
  options: {
    beforeSwap: boolean;
    pendingCount: number;
  },
): string {
  const bonusPart = bonus > 0 ? ` (+${bonus} equipped bonus)` : "";
  const beforePart = options.beforeSwap ? " before swapping" : "";
  return `Complete ${steamQuestCountLabel(options.pendingCount)}${beforePart}${bonusPart}`;
}

function dailyQuestCountLabel(
  pending: ReadonlyArray<{ kind: "daily" | "weekend" }>,
): string {
  const count = pending.length;
  if (count === 0) {
    return "Daily Quests";
  }
  const daily = pending.filter((quest) => quest.kind === "daily").length;
  const weekend = pending.filter((quest) => quest.kind === "weekend").length;
  if (daily > 0 && weekend > 0) {
    return count === 2
      ? "Daily and Weekend Quests"
      : `${count} Daily and Weekend Quests`;
  }
  if (weekend > 0) {
    return count === 1 ? "Weekend Quest" : `${count} Weekend Quests`;
  }
  return count === 1 ? "Daily Quest" : `${count} Daily Quests`;
}

function dailyQuestsActivityLabel(
  pending: ReadonlyArray<{ kind: "daily" | "weekend" }>,
  options: {
    beforeSwap: boolean;
    utcDeadline: boolean;
  },
): string {
  const beforePart = options.beforeSwap ? " before swapping" : "";
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
    steamQuestCount?: number;
    dailyQuestPending?: ReadonlyArray<{ kind: "daily" | "weekend" }>;
  },
): string {
  const beforePart = options.beforeSwap ? " before swapping" : "";
  switch (key) {
    case "steamQuests": {
      return steamQuestsActivityLabel(bonus, {
        beforeSwap: options.beforeSwap,
        pendingCount: options.steamQuestCount ?? 0,
      });
    }
    case "watchTwitch": {
      return twitchActivityLabel(options);
    }
    case "dailyQuests": {
      return dailyQuestsActivityLabel(options.dailyQuestPending ?? [], {
        beforeSwap: options.beforeSwap,
        utcDeadline: options.utcDeadline,
      });
    }
    case "discordPoll": {
      return discordPollActivityLabel(bonus, options);
    }
    case "timeOnSite": {
      // Only remind when this step follows an equip onto a ToS loadout.
      // Skip when ToS is already on, not planned, or slots are locked (phase
      // "other" / before) — otherwise it implies a preceding swap you can't do.
      const equipHint =
        (options.phase === "after" || options.phase === "afterNow") && bonus > 0
          ? " (equip ToS bonus before 5 ARP)"
          : "";
      return `Earn Time on Site ARP${equipHint}${beforePart}`;
    }
    default: {
      return key;
    }
  }
}

// Don't treat a razor-thin post-unlock window as enough for Twitch quests
const TWITCH_UNLOCK_BUFFER_MS = 5 * 60 * 1000;

function msAfterUnlockBeforeReset(waitMs: number, now = new Date()): number {
  return Math.max(0, msUntilUtcMidnight(now) - waitMs);
}

function canFinishTwitchAfterUnlock(
  waitMs: number,
  watchRemainingMs: number,
  now = new Date(),
): boolean {
  return (
    msAfterUnlockBeforeReset(waitMs, now) >=
    watchRemainingMs + TWITCH_UNLOCK_BUFFER_MS
  );
}

/**
 * ARP from one UTC-reset activity on a loadout, including All-ARP%.
 * Used to decide whether waiting for a swap is actually better for that task.
 */
function activityWindowArp(
  combo:
    ActivityLoadoutStats | OptimizerResult["best"] | OptimizerResult["current"],
  key: ActivityKey,
): number {
  let base = 0;
  switch (key) {
    case "watchTwitch": {
      base = BASE_ACTIVITY.watchTwitchBasePerDay;
      break;
    }
    case "dailyQuests": {
      base = BASE_ACTIVITY.dailyQuestBase;
      break;
    }
    case "discordPoll": {
      base = BASE_ACTIVITY.discordPollBase;
      break;
    }
    default: {
      break;
    }
  }
  const flat = comboBonusForActivity(combo, key);
  return (base + flat) * (1 + (combo?.allArpPct ?? 0));
}

function resolveUtcDailyPhase(options: {
  key: ActivityKey;
  needsSwap: boolean;
  waitMs: number;
  canEquipBeforeReset: boolean;
  current: OptimizerResult["current"];
  best: OptimizerResult["best"];
  afterNow: ActivityLoadoutStats | undefined;
  hasImmediateEquip: boolean;
  watchRemainingMs: number;
}): ActivityPhase {
  const {
    key,
    needsSwap,
    waitMs,
    canEquipBeforeReset,
    current,
    best,
    afterNow,
    hasImmediateEquip,
    watchRemainingMs,
  } = options;
  const currentArp = activityWindowArp(current, key);
  const afterNowArp = activityWindowArp(afterNow ?? current, key);
  // Filling a free slot (or replacing a piece that doesn't help this activity)
  // doesn't cost ARP — start the 24h cooldown first, then do the daily.
  if (needsSwap && hasImmediateEquip && afterNowArp >= currentArp) {
    return "afterNow";
  }
  const bestArp = activityWindowArp(best, key);
  // Quests are quick: wait if the better set unlocks before midnight.
  // Twitch waits only if the recommended set's sit (base cap + Twitch flat,
  // 1 ARP/min) still fits before 00:00 UTC.
  if (!needsSwap || !canEquipBeforeReset || bestArp <= currentArp) {
    return "before";
  }
  if (
    key === "watchTwitch" &&
    !canFinishTwitchAfterUnlock(waitMs, watchRemainingMs)
  ) {
    return "before";
  }
  return "after";
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
  current: OptimizerResult["current"];
  best: OptimizerResult["best"];
  afterNow: ActivityLoadoutStats | undefined;
  hasImmediateEquip: boolean;
  watchRemainingMs: number;
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
  } = options;

  if (isUtcDaily) {
    return resolveUtcDailyPhase({
      key,
      needsSwap,
      waitMs,
      canEquipBeforeReset,
      current,
      best,
      afterNow,
      hasImmediateEquip,
      watchRemainingMs,
    });
  }

  if (!needsSwap) {
    return "other";
  }

  if (hasImmediateEquip && afterNowBonus >= currentBonus) {
    return "afterNow";
  }

  // Must do today with whatever is equipped — can't wait for the swap.
  if (expiresBeforeUnlock || currentBonus > bestBonus) {
    return "before";
  }

  if (bestBonus > currentBonus && (waitMs === 0 || canEquipBeforeReset)) {
    return "after";
  }

  if (currentBonus > 0 && currentBonus >= bestBonus) {
    return "before";
  }

  if (bestBonus <= 0) {
    return "other";
  }

  return !canEquipBeforeReset && waitMs > 0 ? "other" : "after";
}

function allArpPctForPhase(
  phase: ActivityPhase,
  current: OptimizerResult["current"],
  best: OptimizerResult["best"],
  afterNow: ActivityLoadoutStats | undefined,
): number {
  if (phase === "after") {
    return best?.allArpPct ?? 0;
  }
  if (phase === "afterNow") {
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
  if (phase === "after") {
    return bestBonus;
  }
  if (phase === "afterNow") {
    return afterNowBonus;
  }
  if (phase === "before") {
    return currentBonus;
  }
  return 0;
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
  const twitchArp =
    key === "watchTwitch"
      ? Math.round((Math.max(0, watchRemainingMs) / 60_000) * (1 + allArpPct))
      : 0;
  return actionUrgency({
    kind: "action",
    readyAtMs: phase === "after" ? waitMs : 0,
    durationMs: key === "watchTwitch" ? Math.max(0, watchRemainingMs) : 0,
    ...(isUtcDaily && { deadlineMs: msUntilUtcMidnight() }),
    arp: key === "watchTwitch" ? twitchArp : bonusForText,
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
    reasons.push({ text: "Equip bonus before starting" });
  }
  const pendingNames = pending
    .map((quest) => quest.name)
    .filter((name) => name.length > 0);
  if (pendingNames.length > 0) {
    reasons.push({ text: pendingNames.join(", ") });
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
  } = options;
  const bonusForText = bonusForActivityPhase(
    phase,
    currentBonus,
    bestBonus,
    afterNowBonus,
  );
  const steamQuests =
    key === "steamQuests"
      ? steamQuestsTodoExtras(siteState, bonusForText)
      : undefined;
  const dailyQuests =
    key === "dailyQuests" ? dailyQuestsTodoExtras(siteState) : undefined;
  const todo: ActionTodo = {
    text: activityLabel(key, bonusForText, {
      beforeSwap: phase === "before" && needsSwap && currentBonus > 0,
      utcDeadline: isUtcDaily,
      phase,
      waitMs,
      watchRemainingMs,
      ...(steamQuests && { steamQuestCount: steamQuests.count }),
      ...(dailyQuests && { dailyQuestPending: dailyQuests.pending }),
    }),
    urgency: activityTodoUrgency({
      key,
      phase,
      waitMs,
      watchRemainingMs,
      isUtcDaily,
      bonusForText,
      allArpPct,
    }),
  };

  if (key === "watchTwitch") {
    todo.openTwitchStream = true;
    const twitchReason = twitchArpReason({
      phase,
      waitMs,
      watchRemainingMs,
      allArpPct,
    });
    if (twitchReason) {
      todo.reasons = [twitchReason];
    }
  } else if (steamQuests?.reasons) {
    todo.reasons = steamQuests.reasons;
  } else if (dailyQuests?.reasons) {
    todo.reasons = dailyQuests.reasons;
  }

  const isUtcUrgent = isUtcDaily && msUntilUtcMidnight() <= 2 * 3_600_000;
  if (isUtcUrgent) {
    todo.tone = "warn";
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
  if (phase === "before") {
    buckets.beforeSwap.push(todo);
    return;
  }
  if (phase === "afterNow") {
    buckets.afterNow.push(todo);
    return;
  }
  if (phase === "after") {
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
function isSequencedActivityDue(
  rule: ActivityTodoRule,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  watchRemainingMs: number,
): boolean {
  if (!isActivityEnabled(settings, rule.key)) {
    return false;
  }
  if (rule.key === "watchTwitch") {
    return (
      watchRemainingMs > 0 && isActivityAvailable(siteState.caps, "watchTwitch")
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
  const canEquipBeforeReset = waitMs <= msUntilUtcMidnight();
  const hasImmediateEquip = (plan?.now.length ?? 0) > 0;
  const afterNow =
    best && plan
      ? activityStatsForArtifacts(
          artifactsAfterImmediateEquip(current, best, plan),
        )
      : undefined;
  const twitchFlatForDue = Math.max(
    comboBonusForActivity(current, "watchTwitch"),
    comboBonusForActivity(afterNow ?? current, "watchTwitch"),
    comboBonusForActivity(best, "watchTwitch"),
  );
  const watchAfterMs = twitchWatchRemainingMs(siteState, twitchFlatForDue);

  for (const rule of ACTIVITY_TODO_RULES) {
    if (!isSequencedActivityDue(rule, settings, siteState, watchAfterMs)) {
      continue;
    }

    const currentBonus = comboBonusForActivity(current, rule.key);
    const bestBonus = comboBonusForActivity(best, rule.key);
    const afterNowBonus = comboBonusForActivity(afterNow ?? current, rule.key);
    const isUtcDaily = ["watchTwitch", "dailyQuests"].includes(rule.key);
    const isExpiresBeforeUnlock =
      isUtcDaily && !canEquipBeforeReset && waitMs > 0;
    const phase = resolveActivityPhase({
      key: rule.key,
      needsSwap,
      expiresBeforeUnlock: isExpiresBeforeUnlock,
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
      watchRemainingMs: watchAfterMs,
    });
    const watchRemainingMs =
      rule.key === "watchTwitch"
        ? twitchWatchRemainingMs(
            siteState,
            bonusForActivityPhase(
              phase,
              currentBonus,
              bestBonus,
              afterNowBonus,
            ),
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
        waitMs: phase === "afterNow" ? 0 : waitMs,
        watchRemainingMs,
        allArpPct: allArpPctForPhase(phase, current, best, afterNow),
        siteState,
      }),
    );
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

  const isNextUtcResetInLock = isResetInWearWindow(
    msUntilUtcMidnight(),
    waitMs,
  );
  const isSteamDueNow = isActivityPending(caps, "steamQuests");
  pushFlatEquipReason(
    reasons,
    stats.steamQuestsFlat,
    waitMs,
    isSteamDueNow,
    isResetInWearWindow(msUntilNextSteamQuestWeek(), waitMs),
    "Steam Quests",
    "Steam Quests after Monday reset",
  );
  pushFlatEquipReason(
    reasons,
    stats.watchTwitchFlat,
    waitMs,
    isActivityAvailable(caps, "watchTwitch"),
    isNextUtcResetInLock,
    "Watch Twitch cap",
    "Watch Twitch cap after 00:00 UTC",
  );
  if (stats.discordPollFlat > 0 && isActivityPending(caps, "discordPoll")) {
    reasons.push({
      text: flatBonusReason(stats.discordPollFlat, "Discord Poll", waitMs),
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
      text: "Still stuck after Refresh? Upgrade a maxed artifact manually (Warrior Script) — 0 fragments",
    });
  }

  return reasons;
}

function comboArtifactsByIds(
  combo: NonNullable<OptimizerResult["best"]>,
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
  const todo: ActionTodo = {
    text: `${headline} - ${loadout}`,
    urgency: urgency ?? {
      kind: "action",
      readyAtMs: 0,
      durationMs: 0,
      chain: "equip",
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

function deferredAllArpTodo(
  deferred: NonNullable<OptimizerResult["deferredAllArp"]>,
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
    reasons: [{ text: parts.join(" · ") }],
    urgency: actionUrgency({
      kind: "schedule",
      readyAtMs: waitMs,
      durationMs: 0,
      ...(typeof unlock.etaMs === "number" && { deadlineMs: unlock.etaMs }),
      arp: unlock.arpReward,
      chain: "equip",
    }),
  });
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
      tone: "warn",
      text: `Equip All-ARP% before playing more Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp)} community-unlocked)`,
      urgency: {
        kind: "action",
        readyAtMs: 0,
        durationMs: 0,
        arp: pending.waitingPersonalArp,
        chain: "equip",
      },
    });
    return;
  }
  if (pending.waitingCommunityArp <= 0) {
    return;
  }
  todos.push({
    tone: "muted",
    text: `Consider All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp)})`,
    urgency: {
      kind: "info",
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
  },
): void {
  const { ownsAllArp, hasAllArpEquipped, isLocked, deferBattlePassClaims } =
    options;
  if (!ownsAllArp || hasAllArpEquipped) {
    return;
  }
  const hasPlannedAllArp = options.hasPlannedAllArp === true;
  if (
    deferBattlePassClaims &&
    battlePassClaimableArp(siteState.battlePass) > 0
  ) {
    const arpReady = battlePassClaimableArp(siteState.battlePass);
    todos.push({
      kind: "caution",
      tone: hasPlannedAllArp ? "warn" : "muted",
      text: `Don't claim Battle Pass ARP Boost yet (${arpReady} ready)`,
      reasons: [
        {
          text: hasPlannedAllArp
            ? "Claim after All-ARP% is on"
            : "More boosts may unlock — claim when All-ARP% is already on",
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

function nowEquipHeadline(plan: LoadoutChangePlan): string {
  const nowNames = plan.now.map((change) => change.displayName).join(" + ");
  const slots = plan.now.map((change) => `slot ${change.position}`).join(", ");
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
      kind: "action",
      readyAtMs: 0,
      durationMs: 0,
      chain: "equip",
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
        loadout: plan.laterNames.join(" + "),
        reasons: laterReasons,
        urgency: {
          kind: "schedule",
          readyAtMs: plan.waitMs,
          durationMs: 0,
          chain: "equip",
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
  best: NonNullable<OptimizerResult["best"]>;
  current: OptimizerResult["current"];
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
      plan.laterNames.length > 0 ? plan.laterNames.join(" + ") : label;
    return {
      immediate: nowUpgrades,
      later: [
        ...laterUpgrades,
        buildEquipTodo({
          headline: `Equip in ${formatMs(swapWaitMs)}`,
          loadout: laterLabel,
          reasons: laterReasons,
          urgency: {
            kind: "schedule",
            readyAtMs: swapWaitMs,
            durationMs: 0,
            chain: "equip",
          },
        }),
      ],
    };
  }
  return {
    immediate: [
      ...nowUpgrades,
      buildEquipTodo({
        headline: beforeSwapCount > 0 ? "Then equip" : "Equip this set",
        loadout: label,
        reasons: laterReasons,
        urgency: {
          kind: "action",
          readyAtMs: 0,
          durationMs: 0,
          chain: "equip",
        },
      }),
    ],
    later: laterUpgrades,
  };
}

function pushEquipPlanTodos(
  todos: ActionTodo[],
  options: {
    best: NonNullable<OptimizerResult["best"]> | undefined;
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
      tone: "warn",
      text: `Slots on cooldown (${formatMs(waitMs)} left)`,
      reasons: [
        {
          text: `Equip All-ARP% before playing Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp)} community-unlocked)`,
        },
      ],
      urgency: {
        kind: "schedule",
        readyAtMs: waitMs,
        durationMs: 0,
        arp: pending.waitingPersonalArp,
        chain: "equip",
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
      tone: "muted",
      text: `Slots on cooldown (${formatMs(waitMs)} left)`,
      reasons: [
        {
          text: `Consider All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp)})`,
        },
      ],
      urgency: {
        kind: "info",
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
        kind: "action",
        readyAtMs: 0,
        durationMs: 0,
        chain: "equip",
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

type DiscordPollSlot = "before" | "afterNow" | "afterFull" | "other";

function isImmediateDiscordUpgrade(
  plan: LoadoutChangePlan,
  best: NonNullable<OptimizerResult["best"]>,
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
    return "afterFull";
  }
  if (needsSwap && canNowEquipHelpPoll) {
    return "afterNow";
  }
  if (needsSwap && isPollBetterAfterSwap) {
    return "before";
  }
  return "other";
}

function discordPollTodoText(options: {
  slot: DiscordPollSlot;
  bonus: number;
  waitMs: number;
  nextPostMs: number;
  nowNames: string;
}): string {
  const { slot, bonus, waitMs, nextPostMs, nowNames } = options;
  const bonusPart = bonus > 0 ? ` (+${bonus} equipped bonus)` : "";
  const nextPost = formatMs(nextPostMs);
  if (slot === "afterFull") {
    return `Vote Discord Poll after unlock (${formatMs(waitMs)} wait, next post in ${nextPost})${bonusPart}`;
  }
  if (slot === "afterNow") {
    return `Vote Discord Poll after equipping ${nowNames}${bonusPart}`;
  }
  if (slot === "before") {
    return `Vote Discord Poll now — next post in ${nextPost}${bonusPart}`;
  }
  if (bonus > 0) {
    return `Vote Discord Poll (+${bonus} already equipped)`;
  }
  return "Vote Discord Poll";
}

function buildDiscordPollAction(options: {
  result: OptimizerResult;
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  needsSwap: boolean;
  waitMs: number;
}): { slot: DiscordPollSlot; todo: ActionTodo } | undefined {
  const { result, settings, siteState, needsSwap, waitMs } = options;
  if (!isActivityEnabled(settings, "discordPoll")) {
    return undefined;
  }
  // ARP Log is the only completion signal — trust it even if caps lagged.
  if (
    hasVotedCurrentDiscordPoll(siteState.arpLog) ||
    !isActivityAvailable(siteState.caps, "discordPoll")
  ) {
    return undefined;
  }
  const nextPostMs = msUntilNextDiscordPollPost();
  const current = result.current;
  const best = result.best;
  const isPollBetterAfterSwap =
    activityWindowArp(best, "discordPoll") >
    activityWindowArp(current, "discordPoll");
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
  const currentBonus = comboBonusForActivity(current, "discordPoll");
  const bestBonus = comboBonusForActivity(best, "discordPoll");
  let phase: ActivityPhase = "other";
  if (slot === "afterFull" || slot === "afterNow") {
    phase = "after";
  } else if (slot === "before") {
    phase = "before";
  }
  const bonus =
    slot === "other"
      ? currentBonus
      : bonusForActivityPhase(phase, currentBonus, bestBonus);
  let chain: ActionTodoChain = "before";
  if (slot === "afterFull") {
    chain = "after";
  } else if (slot === "afterNow") {
    chain = "equip";
  }
  const todo: ActionTodo = {
    text: discordPollTodoText({
      slot,
      bonus,
      waitMs,
      nextPostMs,
      nowNames: plan?.now.map((change) => change.displayName).join(" + ") ?? "",
    }),
    urgency: actionUrgency({
      kind: "action",
      readyAtMs: slot === "afterFull" ? waitMs : 0,
      durationMs: 0,
      deadlineMs: nextPostMs,
      arp: BASE_ACTIVITY.discordPollBase + bonus,
      chain,
    }),
  };
  const twoHoursMs = 2 * 3_600_000;
  if (slot !== "afterFull" && nextPostMs <= twoHoursMs) {
    todo.tone = "warn";
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
  best: NonNullable<OptimizerResult["best"]>;
  current: OptimizerResult["current"];
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
      sequenced.beforeSwap.length + (discord?.slot === "before" ? 1 : 0),
    upgrades,
    ...(slotLocks && { slotLocks }),
  });
  todos.push(
    ...swap.immediate,
    ...sequenced.afterNow,
    ...discordTodoForSlot(discord, "afterNow"),
    ...sequenced.other,
    ...discordTodoForSlot(discord, "other"),
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
  if (discord?.slot === "afterFull") {
    afterSwap.unshift(discord.todo);
  }
  todos.push(...afterSwap);
  if (!isNeedsSwap) {
    todos.push(...sequenced.other, ...discordTodoForSlot(discord, "other"));
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
  if (discord?.slot === "before") {
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
  });

  // Claim BP when All-ARP% is already on, or after a swap that was planned
  // for something else (community). Don't swap onto All-ARP% just for BP.
  // Season ending before All-ARP% can go on → claim on the current set.
  if (shouldDeferBattlePassClaim) {
    pushBattlePassTodo(todos, siteState, {
      ownsAllArp: hasOwnedAllArp,
      hasAllArpEquipped: false,
      afterAllArpEquipped: hasPlannedAllArp,
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

  if (deferredAllArp) {
    todos.push(deferredAllArpTodo(deferredAllArp));
  }

  if (todos.length === 0) {
    return [
      {
        tone: "muted",
        text: "Nothing urgent — check back after activities refresh",
        urgency: { kind: "info", readyAtMs: 0, durationMs: 0 },
      },
    ];
  }

  const cautions = todos.filter((todo) => isCautionTodo(todo));
  const steps = sortActionTodosByUrgency(
    todos.filter((todo) => !isCautionTodo(todo)),
  );
  return [...cautions, ...steps];
}

function actionTodoToneClass(tone: ActionTodo["tone"]): string {
  if (tone === "warn") {
    return " ao-todo-warn";
  }
  if (tone === "muted") {
    return " ao-todo-muted";
  }
  return "";
}

function renderActionTodoBody(todo: ActionTodo): string {
  const parts = [
    `<span class="ao-todo-headline">${escapeHtml(todo.text)}</span>`,
  ];
  if (todo.loadout) {
    parts.push(
      `<span class="ao-todo-loadout">${escapeHtml(todo.loadout)}</span>`,
    );
  }
  if (todo.reasons && todo.reasons.length > 0) {
    const items = todo.reasons
      .map((reason) => {
        const detail = reason.detail
          ? `<div class="ao-todo-reason-detail">${escapeHtml(reason.detail)}</div>`
          : "";
        return `<li><div class="ao-todo-reason-text">${escapeHtml(reason.text)}</div>${detail}</li>`;
      })
      .join("");
    parts.push(`<ul class="ao-todo-reasons">${items}</ul>`);
  }
  return parts.join("");
}

function renderTodoActionButton(todo: ActionTodo): string {
  if (todo.upgradeInstanceId !== undefined) {
    return `<button type="button" class="ao-upgrade-btn" data-id="${todo.upgradeInstanceId}">Upgrade</button>`;
  }
  if (todo.claimBattlePass === true) {
    const skipArp =
      todo.claimBattlePassSkipArp === true ? ' data-skip-arp="1"' : "";
    return `<button type="button" class="ao-claim-btn"${skipArp}>Claim all</button>`;
  }
  if (todo.openTwitchStream === true) {
    return '<button type="button" class="ao-twitch-btn">Open stream</button>';
  }
  return "";
}

function isCautionTodo(todo: ActionTodo): boolean {
  return todo.kind === "caution";
}

/**
 * True when the next step still uses the equipped set (e.g. finish Daily
 * Quests before a later swap). The compact summary should then show current
 * stats instead of advertising the future recommended loadout.
 */
export function isKeepingCurrentLoadout(todos: ActionTodo[]): boolean {
  const firstStep = todos.find((todo) => !isCautionTodo(todo));
  return firstStep?.urgency?.chain !== "equip";
}

export function renderActionPlanContents(todos: ActionTodo[]): string {
  const cautions = todos.filter((todo) => isCautionTodo(todo));
  const steps = todos.filter((todo) => !isCautionTodo(todo));
  const cautionHtml = cautions
    .map((todo) => {
      const toneClass = actionTodoToneClass(todo.tone);
      return `<div class="ao-caution${toneClass}" role="note">${renderActionTodoBody(todo)}</div>`;
    })
    .join("");
  const items = steps
    .map((todo, index) => {
      const toneClass = actionTodoToneClass(todo.tone);
      return `<li class="ao-todo-item${toneClass}"><span class="ao-todo-index">${index + 1}.</span><div class="ao-todo-text">${renderActionTodoBody(todo)}</div>${renderTodoActionButton(todo)}</li>`;
    })
    .join("");
  const listHtml =
    steps.length > 0 ? `<ul class="ao-todo-list">${items}</ul>` : "";
  return `
    <div class="ao-heading">What to do</div>
    ${cautionHtml}
    ${listHtml}
  `;
}

export function renderActionPlan(todos: ActionTodo[]): string {
  return `<div id="ao-action-plan">${renderActionPlanContents(todos)}</div>`;
}
