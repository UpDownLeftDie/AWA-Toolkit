import type { TaskCandidate } from '../../../planner';
import type { PlanContext } from '../buildActionPlan';
import { actionTodoToTask } from '../todoAdapter';

export function provideDiscordPoll(context: PlanContext): TaskCandidate[] {
  const { discord } = context;
  if (!discord) {
    return [];
  }
  return [actionTodoToTask(discord.todo, 'discord:poll')];
}
