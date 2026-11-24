import { BASE_ACTIVITY } from '../data';
import { isActivityPending } from '../siteState';
import { completableUtcDayStarts } from '../optimizer/context';
import { COOLDOWN_MS } from '../settings';
import type { ActivityModule, Opportunity } from './types';

export const dailyQuests: ActivityModule = {
  key: 'dailyQuests',
  cadence: 'utcDaily',
  completion: 'instant',

  isDue(state) {
    return isActivityPending(state.caps, 'dailyQuests');
  },

  opportunities(input) {
    const { state, waitMs, nowMs, horizonMs = COOLDOWN_MS } = input;
    const freq = input.frequency ?? 1;

    const dayStartsMs = completableUtcDayStarts(waitMs, 0, {
      todayAvailable: isActivityPending(state.caps, 'dailyQuests'),
      horizonMs,
      now: nowMs,
    });

    if (dayStartsMs.length === 0) {
      return [];
    }

    const opps: Opportunity[] = [];
    for (const startMs of dayStartsMs) {
      const onDay = new Date(nowMs + startMs);
      opps.push({
        baseArp: BASE_ACTIVITY.dailyQuestBase * freq,
        availableFromMs: startMs,
        breakdownKey: 'dailyQuests',
      });
      if (onDay.getUTCDay() === 0 || onDay.getUTCDay() === 6) {
        opps.push({
          baseArp: BASE_ACTIVITY.weekendQuestBase * freq,
          availableFromMs: startMs,
          breakdownKey: 'weekendQuests',
        });
      }
    }
    return opps;
  },
};
