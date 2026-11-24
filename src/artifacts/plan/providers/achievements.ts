import { buildAchievementTodos } from '../../../achievements/advisor';
import type { AchievementSnapshot } from '../../../achievements/scraper';
import type {
  AchievementSettings,
  AutomationCooldowns,
} from '../../../achievements/settings';
import type { TaskCandidate } from '../../../planner';
import { actionTodoToTask } from '../todoAdapter';
import type { PlanContext } from '../buildActionPlan';

export interface AchievementPlanData {
  snapshot: AchievementSnapshot | undefined;
  settings: AchievementSettings;
  cooldowns: AutomationCooldowns;
}

export function provideAchievements(context: PlanContext): TaskCandidate[] {
  const ach = context.achievementData;
  if (!ach) {
    return [];
  }

  const todos = buildAchievementTodos(ach.snapshot, ach.settings, ach.cooldowns);

  return todos.map((todo, index) => {
    // Determine a stable-ish ID from the todo text slug, with index fallback.
    const slug = todo.text
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .slice(0, 40);
    const id = `achievement:${slug}:${String(index)}`;

    const candidate = actionTodoToTask(todo, id);

    // Achievements yield 0 ARP so ARP tasks win ties.
    candidate.value.arp = 0;

    // Sit after equip/activity work unless the task is already pinFirst.
    if (candidate.constraints.pinFirst !== true) {
      candidate.constraints.chain = 'after';
    }

    return candidate;
  });
}
