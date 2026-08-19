import { describe, expect, it } from 'vitest';

import {
  canCompleteInWearWindow,
  canCompleteOutsideWearWindow,
  isResetInWearWindow,
  isWeeklyForcedIntoLock,
  msUntilNextSteamQuestWeek,
  UTC_DAILY_END_BUFFER_MS,
} from '../../src/artifacts/optimizer/context';
import { COOLDOWN_MS } from '../../src/artifacts/settings';
import { utcAt } from '../fixtures/scenarios/shared';

describe('wear window helpers', () => {
  const midnight = 86_400_000;

  it('canCompleteInWearWindow requires overlap > 0 for instant activities', () => {
    expect(
      canCompleteInWearWindow(midnight, midnight + 86_400_000, 0, 0),
    ).toBe(false);
    expect(
      canCompleteInWearWindow(0, midnight, 0, 0),
    ).toBe(true);
  });

  it('canCompleteOutsideWearWindow respects deadline buffer', () => {
    const duration = 20 * 60_000;
    expect(
      canCompleteOutsideWearWindow(
        0,
        midnight,
        COOLDOWN_MS,
        duration,
        COOLDOWN_MS,
        UTC_DAILY_END_BUFFER_MS,
      ),
    ).toBe(true);
  });

  it('isResetInWearWindow is true only when reset lands inside lock', () => {
    expect(isResetInWearWindow(12 * 3_600_000, 0)).toBe(true);
    expect(isResetInWearWindow(COOLDOWN_MS + 1, 0)).toBe(false);
  });

  it('isWeeklyForcedIntoLock when lock spans week end', () => {
    expect(isWeeklyForcedIntoLock(12 * 3_600_000, 0)).toBe(true);
    expect(isWeeklyForcedIntoLock(3 * 86_400_000, COOLDOWN_MS)).toBe(false);
  });

  it.each([
    {
      label: 'Wednesday mid-week',
      now: utcAt(2026, 7, 6, 12, 0),
      waitMs: 0,
      forced: false,
    },
    {
      label: 'Sunday before Monday with long wait',
      now: utcAt(2026, 7, 9, 20, 0),
      waitMs: COOLDOWN_MS - 2 * 3_600_000,
      forced: true,
    },
  ])(
    'steam week forced into lock: $label',
    ({ now, waitMs, forced }) => {
      const mondayMs = msUntilNextSteamQuestWeek(now);
      expect(isWeeklyForcedIntoLock(mondayMs, waitMs)).toBe(forced);
    },
  );
});
