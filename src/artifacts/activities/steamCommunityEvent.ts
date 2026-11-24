import {
  breakDownCommunityEventPending,
  canEarnCommunityEventArp,
  estimateCommunityUnlockAt,
  isCommunityGateMet,
  isPersonalHoursMet,
} from '../siteState';
import { COOLDOWN_MS } from '../settings';
import type { ActivityModule, OpportunitiesInput, Opportunity } from './types';

/**
Community Event ARP that this 24h lock will still be wearing when it grants.

Ported from `communityEventArpInSwapWindow` in scoring.ts.

Personal-hours-not-met: player-controlled — score it (equip All-ARP% first).
Waiting-on-community: per milestone, only if that gate's ASCE ETA lands
while this loadout is worn (`waitMs` until equip, then 24h).
*/
function communityEventArp(input: OpportunitiesInput): number {
  const { state, waitMs, horizonMs = COOLDOWN_MS } = input;
  const event = state.communityEvent;
  if (!event?.isLive || !canEarnCommunityEventArp(event)) {
    return 0;
  }
  const pending = breakDownCommunityEventPending(event);
  let arp = pending.waitingPersonalArp;
  for (const milestone of event.milestones) {
    if (
      milestone.isAwarded ||
      milestone.arpReward <= 0 ||
      !isPersonalHoursMet(milestone, event.personalHours) ||
      isCommunityGateMet(milestone, event.communityHours)
    ) {
      continue;
    }
    const target = milestone.communityHoursRequired;
    if (target === undefined) {
      continue;
    }
    const eta = estimateCommunityUnlockAt(event, target);
    if (
      eta !== undefined &&
      eta.etaMs >= waitMs &&
      eta.etaMs <= waitMs + horizonMs
    ) {
      arp += milestone.arpReward;
    }
  }
  return arp;
}

export const steamCommunityEvent: ActivityModule = {
  key: 'steamCommunityEvent',
  cadence: 'event',
  completion: 'autoClaim',

  isDue(state) {
    const event = state.communityEvent;
    return Boolean(event?.isLive && canEarnCommunityEventArp(event));
  },

  opportunities(input) {
    const freq = input.frequency ?? 1;
    const arp = communityEventArp(input);
    if (arp <= 0) {
      return [];
    }
    return [
      {
        baseArp: arp * freq,
        availableFromMs: 0,
        breakdownKey: 'steamCommunityEvent',
      } satisfies Opportunity,
    ];
  },
};
