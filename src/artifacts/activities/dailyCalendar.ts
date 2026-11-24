import { BASE_ACTIVITY } from '../data';
import { completableUtcDayStarts } from '../optimizer/context';
import { COOLDOWN_MS } from '../settings';
import type { ActivityModule, Opportunity } from './types';

export const dailyCalendar: ActivityModule = {
  key: 'dailyCalendar',
  cadence: 'utcDaily',
  completion: 'autoClaim',
  bonusBucket: 'dailyCalendar',

  isDue() {
    // Auto-claims on visit; ARP log marks today capped. Only future midnights
    // count — todayAvailable is always false for scoring.
    return true;
  },

  opportunities(input) {
    const { bonuses, waitMs, nowMs, horizonMs = COOLDOWN_MS } = input;
    const freq = input.frequency ?? 1;

    const calendarDays = completableUtcDayStarts(waitMs, 0, {
      todayAvailable: false,
      horizonMs,
      now: nowMs,
    });

    if (calendarDays.length === 0) {
      return [];
    }

    return calendarDays.map(
      (dayStart): Opportunity => ({
        baseArp: BASE_ACTIVITY.dailyCalendarBasePerDay * freq,
        categoryBonus: bonuses.dailyCalendar * freq,
        availableFromMs: dayStart,
        breakdownKey: 'dailyCalendar',
      }),
    );
  },
};
