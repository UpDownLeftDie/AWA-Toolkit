import type { SiteState } from '../../../src/artifacts/siteState/types';
import { isoAt } from './shared';

function baseCaps(
  nowMs: number,
  overrides: Partial<SiteState['caps']> = {},
): SiteState['caps'] {
  const hour = new Date(nowMs).getUTCHours();
  const dailiesCapped = hour >= 23;
  return {
    timeOnSite: dailiesCapped ? 'capped' : 'available',
    watchTwitch: dailiesCapped ? 'capped' : 'available',
    dailyCalendar: dailiesCapped ? 'capped' : 'available',
    dailyQuests: dailiesCapped ? 'capped' : 'available',
    discordPoll: 'available',
    steamCommunityEvent: 'unknown',
    steamQuests: 'available',
    ...overrides,
  };
}

export function baselineScenario(_dayOffset: number, nowMs: number): SiteState {
  return {
    updatedAt: isoAt(nowMs),
    caps: baseCaps(nowMs),
    gameVault: [],
  };
}

export function steamWeekComplete(
  _dayOffset: number,
  nowMs: number,
): SiteState {
  return {
    updatedAt: isoAt(nowMs),
    caps: baseCaps(nowMs, { steamQuests: 'capped' }),
    gameVault: [],
    steamQuests: {
      scrapedAt: isoAt(nowMs),
      quests: [
        {
          name: 'Quest 1',
          rewardArp: 15,
          status: 'complete',
          eligibility: 'eligible',
        },
        {
          name: 'Quest 2',
          rewardArp: 25,
          status: 'complete',
          eligibility: 'eligible',
        },
        {
          name: 'Quest 3',
          rewardArp: 25,
          status: 'complete',
          eligibility: 'eligible',
        },
      ],
    },
  };
}
