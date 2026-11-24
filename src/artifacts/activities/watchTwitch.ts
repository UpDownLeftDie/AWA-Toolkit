import { BASE_ACTIVITY } from '../data';
import { TWITCH_MS_PER_ARP } from '../../core/time';
import { isActivityAvailable, twitchWatchRemainingMs } from '../siteState';
import {
  canCompleteInWearWindow,
  completableUtcDayStarts,
  msUntilNextUtcMidnight,
} from '../optimizer/context';
import { COOLDOWN_MS } from '../settings';
import type { ActivityModule, Opportunity } from './types';

/**
Twitch ARP earnable in a wear window: today's remaining + later full days.

Ported from `twitchArpInWearWindow` in scoring.ts — returns individual
opportunities instead of a single sum so the registry can break them down.
*/
export const watchTwitch: ActivityModule = {
  key: 'watchTwitch',
  cadence: 'utcDaily',
  completion: 'timed',
  bonusBucket: 'watchTwitch',

  isDue(state) {
    return isActivityAvailable(state.caps, 'watchTwitch');
  },

  opportunities(input) {
    const { state, bonuses, waitMs, nowMs, horizonMs = COOLDOWN_MS } = input;
    const twitchFlat = bonuses.watchTwitch;
    const midnight = msUntilNextUtcMidnight(nowMs);
    const todayRemaining =
      twitchWatchRemainingMs(state, twitchFlat) / 60_000;
    const fullDay =
      (state.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) +
      twitchFlat;

    const opps: Opportunity[] = [];

    // Today's remaining
    if (
      todayRemaining > 0 &&
      canCompleteInWearWindow(
        0,
        midnight,
        waitMs,
        todayRemaining * TWITCH_MS_PER_ARP,
        horizonMs,
      )
    ) {
      opps.push({
        baseArp: todayRemaining,
        availableFromMs: 0,
        durationMs: todayRemaining * TWITCH_MS_PER_ARP,
        breakdownKey: 'watchTwitch',
      });
    }

    // Later full days in the wear window
    const laterDays = completableUtcDayStarts(
      waitMs,
      fullDay * TWITCH_MS_PER_ARP,
      { todayAvailable: false, now: nowMs, horizonMs },
    );
    for (const dayStart of laterDays) {
      if (dayStart > 0) {
        opps.push({
          baseArp: fullDay,
          availableFromMs: dayStart,
          durationMs: fullDay * TWITCH_MS_PER_ARP,
          breakdownKey: 'watchTwitch',
        });
      }
    }

    return opps;
  },
};
