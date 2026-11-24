import type { ActivityKey } from '../siteState';
import type { ActivityModule, Opportunity } from './types';
import { steamQuests } from './steamQuests';
import { dailyQuests } from './dailyQuests';
import { watchTwitch } from './watchTwitch';
import { timeOnSite } from './timeOnSite';
import { dailyCalendar } from './dailyCalendar';
import { discordPoll } from './discordPoll';
import { steamCommunityEvent } from './steamCommunityEvent';

/**
Typed activity registry — compiler enforces every ActivityKey is present.
*/
export const ACTIVITIES: Record<ActivityKey, ActivityModule> = {
  steamQuests,
  dailyQuests,
  watchTwitch,
  timeOnSite,
  dailyCalendar,
  discordPoll,
  steamCommunityEvent,
};

export function activityModule(key: ActivityKey): ActivityModule {
  return ACTIVITIES[key];
}

export function allActivityKeys(): ActivityKey[] {
  return Object.keys(ACTIVITIES) as ActivityKey[];
}

/**
Sum opportunity ARP into a flat (pre-multiplier) total, then apply All-ARP%.
Mirrors the original `setBreakdownParts` → `flatSum × multiplier` path.
*/
export function sumOpportunitiesArp(
  opps: Opportunity[],
  allArpPct: number,
): number {
  let flat = 0;
  for (const opp of opps) {
    flat += opp.baseArp + (opp.categoryBonus ?? 0);
  }
  return flat * (1 + allArpPct);
}

export type {
  ActivityCadence,
  ActivityCompletion,
  ActivityLabelContext,
  ActivityModule,
  Opportunity,
  OpportunitiesInput,
} from './types';
