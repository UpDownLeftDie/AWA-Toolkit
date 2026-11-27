import type { TaskCandidate } from '../../../planner';
import type { PlanContext } from '../buildActionPlan';
import { actionTodoToTask } from '../todoAdapter';
import type { ActionTodo } from '../types';
import { pushMarketplaceDiscountPriorityCaution } from '../cautionTodos';
import {
  areAccountActionsEnabled,
  hasElapsedShowroomLock,
  STUCK_SLOT_LOCK_HINT,
} from '../../settings';

/**
True when a planned equip still needs a free slot — stuck locks only matter
then. Otherwise Account actions auto-unstick in the background on Refresh.
*/
function doesPlanNeedFreeSlot(context: PlanContext): boolean {
  return (
    context.isNeedsSwap ||
    context.allArpSchedule.hasScheduledAllArp ||
    context.result.deferredAllArp !== undefined ||
    context.result.deferredSteam !== undefined
  );
}

export function provideCautions(context: PlanContext): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];

  if (
    hasElapsedShowroomLock(
      context.settings,
      context.result.slotLocks,
      context.nowMs,
    ) &&
    doesPlanNeedFreeSlot(context)
  ) {
    const areActionsOn = areAccountActionsEnabled(context.settings);
    candidates.push(
      actionTodoToTask(
        {
          kind: 'caution',
          tone: 'warn',
          text: '24h lock still showing after the timer hit 0',
          reasons: [
            {
              text: areActionsOn
                ? `Auto-unstick didn't clear it. ${STUCK_SLOT_LOCK_HINT}`
                : `Enable Account actions to auto-unstick, or ${STUCK_SLOT_LOCK_HINT}`,
            },
          ],
        },
        'caution:stuckLock',
      ),
    );
  }

  const mpTodos: ActionTodo[] = [];
  pushMarketplaceDiscountPriorityCaution(mpTodos, context.result);
  for (const todo of mpTodos) {
    candidates.push(actionTodoToTask(todo, 'caution:marketplaceDiscount'));
  }

  return candidates;
}
