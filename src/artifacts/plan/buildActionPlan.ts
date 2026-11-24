import type { RankDecision, TaskCandidate } from '../../planner';
import { debugRankTrace, lifetimeArpPolicy, rank } from '../../planner';
import type { OptimizerResult, ScoredCombo } from '../optimizer';
import type { ArtifactOptimizerSettings } from '../settings';
import type { SiteState } from '../siteState';
import {
  type DiscordPollSlot,
  hasAnySlotOnCooldown,
  isSameLoadout,
  type LoadoutChangePlan,
  maxSlotCooldownMs,
  planLoadoutChanges,
} from './shared';
import { buildSequencedActivityTodos } from './activityTodos';
import { battlePassAllArpSchedule } from './battlePassTodos';
import { buildDiscordPollAction } from './discordTodos';
import {
  provideActivities,
  provideBattlePass,
  provideCautions,
  provideDiscordPoll,
  provideEquip,
} from './providers';
import { taskToActionTodo } from './todoAdapter';
import type { ActionTodo } from './types';
import { isCautionTodo } from './types';

export interface PlanContext {
  result: OptimizerResult;
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  nowMs: number;
  best: ScoredCombo | undefined;
  current: ScoredCombo | undefined;
  isMatchingLoadout: boolean;
  isLocked: boolean;
  plan: LoadoutChangePlan | undefined;
  waitMs: number;
  isNeedsSwap: boolean;
  hasAllArpEquipped: boolean;
  hasOwnedAllArp: boolean;
  shouldDeferBattlePassClaim: boolean;
  hasPlannedAllArp: boolean;
  allArpSchedule: {
    hasScheduledAllArp: boolean;
    readyAtMs: number;
    shouldAddEquipTodo: boolean;
  };
  sequenced: {
    beforeSwap: ActionTodo[];
    afterNow: ActionTodo[];
    afterSwap: ActionTodo[];
    other: ActionTodo[];
  };
  discord: { slot: DiscordPollSlot; todo: ActionTodo } | undefined;
  beforeSwapCount: number;
}

type PlanProvider = (context: PlanContext) => TaskCandidate[];

const PLAN_PROVIDERS: readonly PlanProvider[] = [
  provideCautions,
  provideBattlePass,
  provideActivities,
  provideDiscordPoll,
  provideEquip,
];

function computePlanContext(
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  nowMs: number,
): PlanContext {
  const best = result.best;
  const current = result.current;
  const isMatchingLoadout = isSameLoadout(best?.artifacts, current?.artifacts);
  const isLocked = hasAnySlotOnCooldown(current, result.slotLocks);
  const plan = best
    ? planLoadoutChanges(best.artifacts, current, settings, result.slotLocks, nowMs)
    : undefined;
  const waitMs =
    plan?.waitMs ?? maxSlotCooldownMs(settings, current, result.slotLocks, nowMs);
  const isNeedsSwap = Boolean(best && !isMatchingLoadout);

  const hasAllArpEquipped =
    result.hasAllArpEquipped === true || (current?.allArpPct ?? 0) > 0;
  const hasOwnedAllArp =
    result.hasAllArpOwned === true ||
    hasAllArpEquipped ||
    (result.allArpLoadout?.allArpPct ?? 0) > 0 ||
    (best?.allArpPct ?? 0) > 0 ||
    result.alternatives.some((combo) => combo.allArpPct > 0);

  const shouldDeferBattlePassClaim = result.deferBattlePassClaims === true;
  const hasPlannedAllArp = (best?.allArpPct ?? 0) > 0;
  const allArpSchedule = battlePassAllArpSchedule({
    result,
    plan,
    isNeedsSwap,
    settings,
    waitMs,
    hasPlannedAllArp,
    shouldDeferBattlePassClaim,
    nowMs,
  });

  const sequenced = buildSequencedActivityTodos(result, settings, siteState, {
    needsSwap: isNeedsSwap,
    waitMs,
    nowMs,
  });
  const discord = buildDiscordPollAction({
    result,
    settings,
    siteState,
    needsSwap: isNeedsSwap,
    waitMs,
    nowMs,
  });

  const beforeSwapCount =
    sequenced.beforeSwap.length + (discord?.slot === 'before' ? 1 : 0);

  return {
    result,
    settings,
    siteState,
    nowMs,
    best,
    current,
    isMatchingLoadout,
    isLocked,
    plan,
    waitMs,
    isNeedsSwap,
    hasAllArpEquipped,
    hasOwnedAllArp,
    shouldDeferBattlePassClaim,
    hasPlannedAllArp,
    allArpSchedule,
    sequenced,
    discord,
    beforeSwapCount,
  };
}

const EMPTY_TODO: ActionTodo = {
  tone: 'muted',
  text: 'Nothing urgent — check back after activities refresh',
  urgency: { kind: 'info', readyAtMs: 0, durationMs: 0 },
};

/**
Turn soft chain tags into hard before/after edges against equip steps so
`rank()`'s constraint graph enforces "before swap" / "after swap".
*/
function wireEquipConstraints(candidates: TaskCandidate[]): TaskCandidate[] {
  const equipIds = candidates
    .filter(
      (task) =>
        task.constraints.chain === 'equip' || task.action?.type === 'equip',
    )
    .map((task) => task.id);
  if (equipIds.length === 0) {
    return candidates;
  }
  return candidates.map((task) => {
    if (task.constraints.chain === 'before') {
      return {
        ...task,
        constraints: {
          ...task.constraints,
          before: [...(task.constraints.before ?? []), ...equipIds],
        },
      };
    }
    if (task.constraints.chain === 'after') {
      return {
        ...task,
        constraints: {
          ...task.constraints,
          after: [...(task.constraints.after ?? []), ...equipIds],
        },
      };
    }
    return task;
  });
}

function buildPlanInternal(
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  nowMs: number,
): { todos: ActionTodo[]; trace: RankDecision[] } {
  const context = computePlanContext(result, settings, siteState, nowMs);
  const candidates = wireEquipConstraints(
    PLAN_PROVIDERS.flatMap((provider) => provider(context)),
  );
  const { ordered, trace } = rank(candidates, lifetimeArpPolicy);
  if ((globalThis as Record<string, unknown>).__AWA_PLAN_TRACE__ === true) {
    debugRankTrace({ ordered, trace });
  }
  const todos = ordered.map((task) => taskToActionTodo(task));

  if (todos.length === 0) {
    return { todos: [EMPTY_TODO], trace };
  }

  return { todos, trace };
}

/**
Maximize ARP under cooldowns: finish current-set strengths first only when
the next equip would drop that activity's ARP. Fill free slots now (sooner
cooldowns), remaining pieces when they unlock, then activities the new set
is better for.
*/
export function buildActionPlan(
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  nowMs = Date.now(),
): ActionTodo[] {
  return buildPlanInternal(result, settings, siteState, nowMs).todos;
}

/**
Same as `buildActionPlan` but also returns the rank trace for UI display.
*/
export function buildActionPlanDetailed(
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  nowMs = Date.now(),
): { todos: ActionTodo[]; trace: RankDecision[] } {
  return buildPlanInternal(result, settings, siteState, nowMs);
}

/**
True when the next step still uses the equipped set (e.g. finish Daily
Quests before a later swap). The compact summary should then show current
stats instead of advertising the future recommended loadout.
*/
export function isKeepingCurrentLoadout(todos: ActionTodo[]): boolean {
  const firstStep = todos.find((todo) => !isCautionTodo(todo));
  return firstStep?.urgency?.chain !== 'equip';
}
