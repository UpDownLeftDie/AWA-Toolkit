import type { TaskCandidate } from '../../../planner';
import type { PlanContext } from '../buildActionPlan';
import { actionTodoToTask } from '../todoAdapter';

export function provideActivities(context: PlanContext): TaskCandidate[] {
  const { sequenced } = context;
  const all = [
    ...sequenced.beforeSwap,
    ...sequenced.afterNow,
    ...sequenced.afterSwap,
    ...sequenced.other,
  ];
  return all.map((todo, index) =>
    actionTodoToTask(todo, `activity:${String(index)}`),
  );
}
