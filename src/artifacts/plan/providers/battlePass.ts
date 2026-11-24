import type { TaskCandidate } from '../../../planner';
import type { PlanContext } from '../buildActionPlan';
import { actionTodoToTask } from '../todoAdapter';
import type { ActionTodo } from '../types';
import { pushBattlePassTodo, pushStartBattlePassTodo } from '../battlePassTodos';

export function provideBattlePass(context: PlanContext): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];

  const startTodos: ActionTodo[] = [];
  pushStartBattlePassTodo(startTodos, context.siteState);
  for (const todo of startTodos) {
    candidates.push(actionTodoToTask(todo, 'bp:start'));
  }

  const claimTodos: ActionTodo[] = [];
  if (context.shouldDeferBattlePassClaim) {
    pushBattlePassTodo(claimTodos, context.siteState, {
      ownsAllArp: context.hasOwnedAllArp,
      hasAllArpEquipped: false,
      afterAllArpEquipped: context.allArpSchedule.hasScheduledAllArp,
      allArpReadyAtMs: context.allArpSchedule.readyAtMs,
      nowMs: context.nowMs,
    });
  } else {
    pushBattlePassTodo(claimTodos, context.siteState, {
      ownsAllArp: context.hasOwnedAllArp,
      hasAllArpEquipped: context.hasAllArpEquipped,
      seasonEndsBeforeAllArp: context.hasOwnedAllArp && !context.hasAllArpEquipped,
      nowMs: context.nowMs,
    });
  }
  for (const [index, todo] of claimTodos.entries()) {
    candidates.push(actionTodoToTask(todo, `bp:claim:${String(index)}`));
  }

  return candidates;
}
