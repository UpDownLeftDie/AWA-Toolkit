import type { CommunityEventState } from '../../../src/artifacts/siteState/communityEvent';
import type { SiteState } from '../../../src/artifacts/siteState/types';
import { baselineScenario } from './baseline';
import { isoAt } from './shared';

/**
~29 days from 62k → 150k community hours.
*/
const COMMUNITY_HOURS_START = 62_000;
const COMMUNITY_HOURS_PER_DAY = 3000;
const COMMUNITY_HOURS_CAP = 150_000;

function communityHoursForDay(dayOffset: number): number {
  return Math.min(
    COMMUNITY_HOURS_CAP,
    COMMUNITY_HOURS_START + dayOffset * COMMUNITY_HOURS_PER_DAY,
  );
}

function communityEventAt(
  nowMs: number,
  dayOffset: number,
): CommunityEventState {
  const currentHours = communityHoursForDay(dayOffset);
  const sampleAt = new Date(nowMs - 6 * 3_600_000).toISOString();
  const milestones = [
    {
      index: 0,
      personalHoursRequired: 50,
      communityHoursRequired: 50_000,
      arpReward: 5,
      rewardLabel: '5 ARP',
      isCommunityUnlocked: currentHours >= 50_000,
      isAwarded: false,
    },
    {
      index: 1,
      personalHoursRequired: 80,
      communityHoursRequired: 75_000,
      arpReward: 5,
      rewardLabel: '5 ARP',
      isCommunityUnlocked: currentHours >= 75_000,
      isAwarded: false,
    },
    {
      index: 2,
      personalHoursRequired: 100,
      communityHoursRequired: 100_000,
      arpReward: 10,
      rewardLabel: '10 ARP',
      isCommunityUnlocked: currentHours >= 100_000,
      isAwarded: false,
    },
    {
      index: 3,
      personalHoursRequired: 120,
      communityHoursRequired: 150_000,
      arpReward: 10,
      rewardLabel: '10 ARP',
      isCommunityUnlocked: currentHours >= 150_000,
      isAwarded: false,
    },
  ];
  return {
    scrapedAt: isoAt(nowMs),
    url: '/steam/community-event/test',
    title: 'Test Community Event',
    isLive: true,
    personalHours: 120,
    communityHours: currentHours,
    communityHoursCap: COMMUNITY_HOURS_CAP,
    communityHoursSamples: [
      { at: sampleAt, hours: Math.max(0, currentHours - 800) },
      { at: isoAt(nowMs - 3_600_000), hours: Math.max(0, currentHours - 400) },
      { at: isoAt(nowMs), hours: currentHours },
    ],
    communityHoursSource: 'asce',
    milestones,
    pendingArp: milestones
      .filter(
        (milestone) =>
          milestone.arpReward > 0 &&
          !milestone.isAwarded &&
          milestone.isCommunityUnlocked &&
          120 >= milestone.personalHoursRequired,
      )
      .reduce((sum, milestone) => sum + milestone.arpReward, 0),
    awardedArp: 0,
    playEligibility: 'eligible',
  };
}

export function communityOnlyScenario(
  dayOffset: number,
  nowMs: number,
): SiteState {
  return {
    ...baselineScenario(dayOffset, nowMs),
    caps: {
      ...baselineScenario(dayOffset, nowMs).caps,
      steamCommunityEvent: 'available',
    },
    communityEvent: communityEventAt(nowMs, dayOffset),
  };
}

/**
Community lump near 150k gate with a smaller pending gate first.
*/
export function communityTenArpLumpScenario(
  dayOffset: number,
  nowMs: number,
): SiteState {
  const event = communityEventAt(nowMs, dayOffset);
  event.communityHours = Math.min(
    COMMUNITY_HOURS_CAP,
    149_500 + dayOffset * COMMUNITY_HOURS_PER_DAY,
  );
  event.communityHoursSamples = [
    {
      at: isoAt(nowMs - 12 * 3_600_000),
      hours: Math.max(0, event.communityHours - 1500),
    },
    { at: isoAt(nowMs - 6 * 3_600_000), hours: event.communityHours - 500 },
    { at: isoAt(nowMs), hours: event.communityHours },
  ];
  event.milestones = [
    {
      index: 0,
      personalHoursRequired: 50,
      communityHoursRequired: 100_000,
      arpReward: 10,
      rewardLabel: '10 ARP',
      isCommunityUnlocked: event.communityHours >= 100_000,
      isAwarded: false,
    },
    {
      index: 1,
      personalHoursRequired: 100,
      communityHoursRequired: 150_000,
      arpReward: 10,
      rewardLabel: '10 ARP',
      isCommunityUnlocked: event.communityHours >= 150_000,
      isAwarded: false,
    },
  ];
  event.pendingArp = event.milestones
    .filter(
      (milestone) =>
        milestone.isCommunityUnlocked &&
        120 >= milestone.personalHoursRequired &&
        !milestone.isAwarded,
    )
    .reduce((sum, milestone) => sum + milestone.arpReward, 0);
  return {
    ...baselineScenario(dayOffset, nowMs),
    caps: {
      ...baselineScenario(dayOffset, nowMs).caps,
      steamCommunityEvent: 'available',
    },
    communityEvent: event,
  };
}
