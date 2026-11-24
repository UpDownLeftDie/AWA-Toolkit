import {
  ArtifactEffectType,
  BASE_ACTIVITY,
  getArtifactById,
  msUntilNextDiscordPollPost,
} from '../data';
import type { ArtifactOptimizerSettings } from '../settings';
import type { OptimizerResult } from '../optimizer';
import {
  type ActivityKey,
  hasVotedCurrentDiscordPoll,
  isActivityAvailable,
  type SiteState,
} from '../siteState';
import {
  type LoadoutChangePlan,
  planLoadoutChanges,
} from '../optimizer/swapPlan';
import {
  formatMs,
} from '../loadoutFormat';
import type {
  ActionTodo,
  ActionTodoChain,
  ActionTodoReason,
} from './types';
import {
  actionUrgency,
  type ActivityPhase,
  activityWindowArp,
  bonusForActivityPhase,
  comboBonusForActivity,
  type DiscordPollSlot,
} from './shared';

// ── Discord poll helpers ───────────────────────────────────────────────

function isActivityEnabled(
  settings: ArtifactOptimizerSettings,
  key: ActivityKey,
): boolean {
  return settings.activities[key].enabled;
}

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
  if (needsSwap && isPollBetterAfterSwap && waitMs < nextPostMs) {
    return waitMs > 0 ? 'afterFull' : 'afterNow';
  }
  if (needsSwap && canNowEquipHelpPoll) {
    return 'afterNow';
  }
  return needsSwap && isPollBetterAfterSwap ? 'before' : 'other';
}

function discordPollTodoText(options: {
  slot: DiscordPollSlot;
  bonus: number;
  nextPostMs: number;
}): string {
  const { slot, bonus, nextPostMs } = options;
  if (slot === 'afterFull' || slot === 'afterNow') {
    return 'Vote Discord Poll';
  }
  const bonusPart = bonus > 0 ? ` (+${String(bonus)} equipped bonus)` : '';
  const nextPost = formatMs(nextPostMs);
  if (slot === 'before') {
    return `Vote Discord Poll now — next post in ${nextPost}${bonusPart}`;
  }
  return bonus > 0
    ? `Vote Discord Poll (+${String(bonus)} already equipped)`
    : 'Vote Discord Poll';
}

function discordPollTodoReasons(
  slot: DiscordPollSlot,
): ActionTodoReason[] | undefined {
  return slot === 'afterFull' || slot === 'afterNow'
    ? [{ text: 'After equipping' }]
    : undefined;
}

export function buildDiscordPollAction(options: {
  result: OptimizerResult;
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  needsSwap: boolean;
  waitMs: number;
  nowMs: number;
}): { slot: DiscordPollSlot; todo: ActionTodo } | undefined {
  const { result, settings, siteState, needsSwap, waitMs, nowMs } = options;
  if (
    !isActivityEnabled(settings, 'discordPoll') ||
    hasVotedCurrentDiscordPoll(siteState.arpLog, new Date(nowMs)) ||
    !isActivityAvailable(siteState.caps, 'discordPoll')
  ) {
    return undefined;
  }
  const nextPostMs = msUntilNextDiscordPollPost(new Date(nowMs));
  const current = result.current;
  const best = result.best;
  const isPollBetterAfterSwap =
    activityWindowArp(best, 'discordPoll', siteState, nowMs) >
    activityWindowArp(current, 'discordPoll', siteState, nowMs);
  const plan =
    best === undefined
      ? undefined
      : planLoadoutChanges(best.artifacts, current, settings, result.slotLocks, nowMs);
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
  const reasons = discordPollTodoReasons(slot);
  const todo: ActionTodo = {
    text: discordPollTodoText({
      slot,
      bonus,
      nextPostMs,
    }),
    urgency: actionUrgency({
      kind: slot === 'afterFull' ? 'schedule' : 'action',
      readyAtMs: slot === 'afterFull' ? waitMs : 0,
      durationMs: 0,
      deadlineMs: nextPostMs,
      arp: BASE_ACTIVITY.discordPollBase + bonus,
      chain,
    }),
  };
  if (reasons) {
    todo.reasons = reasons;
  }
  const twoHoursMs = 2 * 3_600_000;
  if (slot !== 'afterFull' && nextPostMs <= twoHoursMs) {
    todo.tone = 'warn';
  }
  return { slot, todo };
}

export function discordTodoForSlot(
  discord: { slot: DiscordPollSlot; todo: ActionTodo } | undefined,
  slot: DiscordPollSlot,
): ActionTodo[] {
  return discord?.slot === slot ? [discord.todo] : [];
}
