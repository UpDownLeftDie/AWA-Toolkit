/**
Pure day-ARP helpers shared between:
  - `forcedDailyArpDelta` in optimizer/search.ts (All-ARP lock cost accounting)
  - `activityWindowArp` in plan/helpers.ts (planner single-window ARP display)

Each function is pure: takes only constants + minimal bonus fields + SiteState,
no side effects. Numbers must stay identical to previous inline implementations —
existing unit/audit/sim tests are the gate.

Callers pass the two or three fields they actually have rather than a full
BonusBuckets, so both the optimizer (which has BonusBuckets) and the planner
(which has ActivityLoadoutStats or a plain allArpPct) can call without casting.
*/
import { BASE_ACTIVITY } from '../data';
import { MS_PER_MINUTE, TWITCH_MS_PER_ARP } from '../../core/time';
import { twitchWatchRemainingMs } from '../siteState';
import type { SiteState } from '../siteState/types';

/*
Subset needed for Twitch day-ARP calculations.
*/
export interface TwitchDayArpInput {
  watchTwitch: number;
  allArpPct: number;
}

/*
Subset needed for Time-on-Site day-ARP calculations.
*/
export interface TosDayArpInput {
  timeOnSite: number;
  allArpPct: number;
}

/*
Subset needed for Daily Calendar day-ARP calculations.
*/
export interface CalendarDayArpInput {
  dailyCalendar: number;
  allArpPct: number;
}

/*
Subset needed for daily quest day-ARP calculations.
*/
export interface QuestDayArpInput {
  allArpPct: number;
}

/**
Twitch ARP for a single UTC day, applying All-ARP%.
  - `isToday = true`: uses today's remaining minutes (< full cap).
  - `isToday = false`: uses the full day cap (bonus + base).
*/
export function twitchDayArp(
  bonuses: TwitchDayArpInput,
  siteState: SiteState,
  isToday: boolean,
): number {
  const cap =
    (siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) +
    bonuses.watchTwitch;
  const remaining = twitchWatchRemainingMs(siteState, bonuses.watchTwitch) / 60_000;
  const base = isToday ? remaining : cap;
  return base * (1 + bonuses.allArpPct);
}

/**
Duration in ms to watch Twitch on a single UTC day.
  - `isToday = true`: today's remaining watch time.
  - `isToday = false`: the full day cap (bonus + base).
*/
export function twitchDayDurationMs(
  bonuses: TwitchDayArpInput,
  siteState: SiteState,
  isToday: boolean,
): number {
  const cap =
    (siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) +
    bonuses.watchTwitch;
  const remaining = twitchWatchRemainingMs(siteState, bonuses.watchTwitch) / 60_000;
  return (isToday ? remaining : cap) * TWITCH_MS_PER_ARP;
}

/*
Duration in ms to earn Time-on-Site ARP on any day.
*/
export const TIME_ON_SITE_DURATION_MS =
  BASE_ACTIVITY.timeOnSiteBasePerDay * MS_PER_MINUTE;

/**
Time-on-Site ARP for one day, applying All-ARP%.
*/
export function timeOnSiteDayArp(bonuses: TosDayArpInput): number {
  return (BASE_ACTIVITY.timeOnSiteBasePerDay + bonuses.timeOnSite) *
    (1 + bonuses.allArpPct);
}

/**
Daily Calendar ARP for one day, applying All-ARP%.
*/
export function dailyCalendarDayArp(bonuses: CalendarDayArpInput): number {
  return (BASE_ACTIVITY.dailyCalendarBasePerDay + bonuses.dailyCalendar) *
    (1 + bonuses.allArpPct);
}

/**
Daily quest ARP for one UTC day (adds weekend quest base when applicable),
applying All-ARP%.
  - `onDay`: the Date at which the quest day falls (used to detect weekend).
*/
export function dailyQuestDayArp(bonuses: QuestDayArpInput, onDay: Date): number {
  const weekend =
    onDay.getUTCDay() === 0 || onDay.getUTCDay() === 6
      ? BASE_ACTIVITY.weekendQuestBase
      : 0;
  const base = BASE_ACTIVITY.dailyQuestBase + weekend;
  return base * (1 + bonuses.allArpPct);
}
