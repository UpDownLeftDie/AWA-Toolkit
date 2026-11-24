import { BASE_ACTIVITY } from '../data';
import { isActivityPending } from '../siteState';
import type { ActivityModule, Opportunity } from './types';

export const discordPoll: ActivityModule = {
  key: 'discordPoll',
  cadence: 'weekdayPoll',
  completion: 'instant',
  bonusBucket: 'discordPoll',

  isDue(state) {
    return isActivityPending(state.caps, 'discordPoll');
  },

  opportunities(input) {
    const { state, bonuses } = input;

    if (!isActivityPending(state.caps, 'discordPoll')) {
      return [];
    }

    const freq = input.frequency ?? 1;
    const polls = BASE_ACTIVITY.discordPollsWhenPending * freq;
    return [
      {
        baseArp: BASE_ACTIVITY.discordPollBase * polls,
        categoryBonus: bonuses.discordPoll * polls,
        availableFromMs: 0,
        breakdownKey: 'discordPoll',
      } satisfies Opportunity,
    ];
  },
};
