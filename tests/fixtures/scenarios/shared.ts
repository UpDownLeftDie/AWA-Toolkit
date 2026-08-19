import type { SiteState } from '../../../src/artifacts/siteState/types';

/** Synthetic month anchor: 2026-08-01 00:00:00 UTC (Saturday). */
export const MONTH_START_MS = Date.UTC(2026, 7, 1);

export type MonthScenario = (
  dayOffset: number,
  nowMs: number,
) => SiteState;

export function utcAt(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): number {
  return Date.UTC(year, month, day, hour, minute);
}

export function dayOffsetAt(nowMs: number): number {
  return Math.floor((nowMs - MONTH_START_MS) / 86_400_000);
}

export function isoAt(nowMs: number): string {
  return new Date(nowMs).toISOString();
}
