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

export function incompleteSteamQuests(
  nowMs: number,
): NonNullable<SiteState['steamQuests']> {
  return {
    scrapedAt: isoAt(nowMs),
    quests: [
      {
        name: 'Quest 1',
        rewardArp: 15,
        status: 'incomplete',
        eligibility: 'eligible',
      },
      {
        name: 'Quest 2',
        rewardArp: 25,
        status: 'incomplete',
        eligibility: 'eligible',
      },
      {
        name: 'Quest 3',
        rewardArp: 25,
        status: 'incomplete',
        eligibility: 'eligible',
      },
    ],
  };
}

/**
Steam week still open (Control Center rows incomplete) and Twitch still
due when the UTC day hasn't rolled over. The audit grid uses this so
this week's remaining Steam is scored on the 24h pick — `baseline` only
sets the cap flag.
*/
export function steamWeekOpen(_dayOffset: number, nowMs: number): SiteState {
  const base = baselineScenario(_dayOffset, nowMs);
  const twitchDue = base.caps.watchTwitch === 'available';
  return {
    ...base,
    steamQuests: incompleteSteamQuests(nowMs),
    ...(twitchDue && {
      watchTwitch: {
        scrapedAt: isoAt(nowMs),
        baseArp: 0,
        bonusArp: 0,
        timeWatched: 0,
        isUnderCap: true,
        capArp: 15,
        remainingMs: 15 * 60_000,
      },
    }),
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
