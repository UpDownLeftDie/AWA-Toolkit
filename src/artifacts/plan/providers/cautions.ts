import type { TaskCandidate } from '../../../planner';
import type { PlanContext } from '../buildActionPlan';
import { actionTodoToTask } from '../todoAdapter';
import type { ActionTodo } from '../types';
import { pushMarketplaceDiscountPriorityCaution } from '../cautionTodos';
import { hasElapsedShowroomLock, STUCK_SLOT_LOCK_HINT } from '../../settings';

export function provideCautions(context: PlanContext): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];

  if (hasElapsedShowroomLock(context.settings, context.result.slotLocks, context.nowMs)) {
    candidates.push(
      actionTodoToTask(
        {
          kind: 'caution',
          tone: 'warn',
          text: '24h lock still showing after the timer hit 0',
          reasons: [{ text: STUCK_SLOT_LOCK_HINT }],
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
