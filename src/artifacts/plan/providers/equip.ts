import type { TaskCandidate } from '../../../planner';
import type { PlanContext } from '../buildActionPlan';
import { actionTodoToTask } from '../todoAdapter';
import type { ActionTodo } from '../types';
import {
  buildSwapEquipTodos,
  deferredSteamTodo,
  pushEquipPlanTodos,
  shouldFoldDeferredSteam,
} from '../equipTodos';
import {
  pushAllArpGuardTodos,
  pushScheduledAllArpTodos,
} from '../battlePassTodos';

export function provideEquip(context: PlanContext): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];

  const {
    result,
    settings,
    siteState,
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
    beforeSwapCount,
    nowMs,
  } = context;

  let equipTodoIndex = 0;
  function pushEquipCandidate(todo: ActionTodo, label: string): void {
    candidates.push(
      actionTodoToTask(todo, `equip:${label}:${String(equipTodoIndex++)}`),
    );
  }

  if (best && isNeedsSwap) {
    const swap = buildSwapEquipTodos({
      best,
      current,
      settings,
      siteState,
      isLocked,
      waitMs,
      beforeSwapCount,
      upgrades: result.upgrades,
      isPreloadNextUtcDay: result.preloadNextUtcDay === true,
      nowMs,
      ...(result.slotLocks && { slotLocks: result.slotLocks }),
      ...(result.deferredSteam && { deferredSteam: result.deferredSteam }),
    });
    for (const todo of swap.immediate) {
      pushEquipCandidate(todo, 'swapNow');
    }
    for (const todo of swap.later) {
      pushEquipCandidate(todo, 'swapLater');
    }
  } else {
    const equipTodos: ActionTodo[] = [];
    pushEquipPlanTodos(equipTodos, {
      best,
      siteState,
      isMatchingLoadout,
      isLocked,
      waitMs,
      hasOwnedAllArp,
      hasAllArpEquipped,
      upgrades: result.upgrades,
    });
    for (const todo of equipTodos) {
      pushEquipCandidate(todo, 'plan');
    }
  }

  const guardTodos: ActionTodo[] = [];
  pushAllArpGuardTodos(guardTodos, siteState, {
    ownsAllArp: hasOwnedAllArp,
    hasAllArpEquipped,
    isLocked,
    deferBattlePassClaims: shouldDeferBattlePassClaim,
    hasPlannedAllArp,
    hasDeferredAllArp: result.deferredAllArp !== undefined,
    hasScheduledAllArp: allArpSchedule.hasScheduledAllArp,
    allArpLoadout: result.allArpLoadout,
  });
  for (const todo of guardTodos) {
    pushEquipCandidate(todo, 'guard');
  }

  if (
    result.deferredSteam &&
    !shouldFoldDeferredSteam(best, result.deferredSteam, isNeedsSwap)
  ) {
    pushEquipCandidate(
      deferredSteamTodo(result.deferredSteam, siteState, nowMs),
      'deferredSteam',
    );
  }

  const scheduledTodos: ActionTodo[] = [];
  pushScheduledAllArpTodos(
    scheduledTodos,
    result,
    settings,
    siteState,
    plan,
    isNeedsSwap,
    allArpSchedule.shouldAddEquipTodo,
    nowMs,
  );
  for (const todo of scheduledTodos) {
    pushEquipCandidate(todo, 'scheduledAllArp');
  }

  return candidates;
}
