import { BASE_ACTIVITY } from '../data';
import { MS_PER_MINUTE } from '../../core/time';
import { isActivityAvailable } from '../siteState';
import { completableUtcDayStarts } from '../optimizer/context';
import { COOLDOWN_MS } from '../settings';
import type { ActivityModule, Opportunity } from './types';

const TIME_ON_SITE_DURATION_MS =
  BASE_ACTIVITY.timeOnSiteBasePerDay * MS_PER_MINUTE;

export const timeOnSite: ActivityModule = {
  key: 'timeOnSite',
  cadence: 'utcDaily',
  completion: 'timed',
  bonusBucket: 'timeOnSite',

  isDue(state) {
    return isActivityAvailable(state.caps, 'timeOnSite');
  },

  opportunities(input) {
    const { state, bonuses, waitMs, nowMs, horizonMs = COOLDOWN_MS } = input;
    const freq = input.frequency ?? 1;

    const tosDays = completableUtcDayStarts(
      waitMs,
      TIME_ON_SITE_DURATION_MS,
      {
        todayAvailable: isActivityAvailable(state.caps, 'timeOnSite'),
        horizonMs,
        now: nowMs,
      },
    );

    if (tosDays.length === 0) {
      return [];
    }

    return tosDays.map(
      (dayStart): Opportunity => ({
        baseArp: BASE_ACTIVITY.timeOnSiteBasePerDay * freq,
        categoryBonus: bonuses.timeOnSite * freq,
        availableFromMs: dayStart,
        durationMs: TIME_ON_SITE_DURATION_MS,
        breakdownKey: 'timeOnSite',
      }),
    );
  },
};
