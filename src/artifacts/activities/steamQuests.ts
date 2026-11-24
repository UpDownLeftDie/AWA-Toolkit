import { BASE_ACTIVITY } from '../data';
import {
  isActivityPending,
  scrapedRemainingSteamQuestRewards,
} from '../siteState';
import {
  isResetInWearWindow,
  msUntilNextSteamQuestWeek,
} from '../optimizer/context';
import { COOLDOWN_MS } from '../settings';
import type { ActivityModule, OpportunitiesInput, Opportunity } from './types';

/**
Remaining Steam Quest base ARP amounts in this wear window.

Credit remaining quests whenever they are pending — waiting for last-chance
Monday just pushes Steam off forever. Next week's 15+25+25 only if Monday
00:00 UTC actually lands while worn.
*/
function steamBasesInWearWindow(
  input: OpportunitiesInput,
): number[] {
  const { state, waitMs, nowMs, horizonMs = COOLDOWN_MS } = input;
  const mondayResetMs = msUntilNextSteamQuestWeek(nowMs);
  const bases: number[] = [];

  const remaining = scrapedRemainingSteamQuestRewards(state);
  if (
    remaining &&
    remaining.length > 0 &&
    isActivityPending(state.caps, 'steamQuests')
  ) {
    bases.push(...remaining);
  }

  if (isResetInWearWindow(mondayResetMs, waitMs, horizonMs)) {
    bases.push(...BASE_ACTIVITY.steamQuestBases);
  }
  return bases;
}

export const steamQuests: ActivityModule = {
  key: 'steamQuests',
  cadence: 'weekly',
  completion: 'instant',
  bonusBucket: 'steamQuests',

  isDue(state) {
    return isActivityPending(state.caps, 'steamQuests');
  },

  opportunities(input) {
    const freq = input.frequency ?? 1;
    const bases = steamBasesInWearWindow(input);
    if (bases.length === 0) {
      return [];
    }
    return bases.map(
      (base): Opportunity => ({
        baseArp: base * freq,
        categoryBonus: input.bonuses.steamQuests * freq,
        availableFromMs: 0,
        breakdownKey: 'steamQuests',
      }),
    );
  },
};
