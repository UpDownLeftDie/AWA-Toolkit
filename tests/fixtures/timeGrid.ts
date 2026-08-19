import { COOLDOWN_MS } from '../../src/artifacts/settings';
import { MONTH_START_MS, utcAt } from './scenarios/shared';

const MS_PER_DAY = 86_400_000;

/** Every UTC day at 08:00, 16:00, and 23:00 across a 30-day synthetic month. */
function dailyGrid(): number[] {
  const times: number[] = [];
  for (let day = 0; day < 30; day += 1) {
    const base = MONTH_START_MS + day * MS_PER_DAY;
    times.push(base + 8 * 3_600_000);
    times.push(base + 16 * 3_600_000);
    times.push(base + 23 * 3_600_000);
  }
  return times;
}

/** Sunday before Monday steam reset, Wednesday mid-week, slot-unlock edges. */
function edgeCases(): number[] {
  return [
    utcAt(2026, 7, 3, 20, 0),
    utcAt(2026, 7, 4, 0, 0),
    utcAt(2026, 7, 6, 12, 0),
    utcAt(2026, 7, 10, 8, 0),
    utcAt(2026, 7, 17, 16, 0),
    utcAt(2026, 7, 24, 23, 0),
    MONTH_START_MS + COOLDOWN_MS - 3_600_000,
    MONTH_START_MS + COOLDOWN_MS + 3_600_000,
  ];
}

export const AUDIT_TIME_GRID: readonly number[] = [
  ...new Set([...dailyGrid(), ...edgeCases()]),
].toSorted((left, right) => left - right);

export function wednesdayMidWeekSteamCompleteMs(): number {
  return utcAt(2026, 7, 6, 12, 0);
}
