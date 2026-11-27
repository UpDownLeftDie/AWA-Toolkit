import { describe, expect, it } from 'vitest';

import {
  applyCommunityHoursUnlocks,
  breakDownCommunityEventPending,
  isNonArpRewardLabel,
  mergeCommunityEventScrape,
  upsertCommunityEventMilestoneGates,
  type CommunityEventState,
} from '../../src/artifacts/siteState/communityEvent';
import { isoAt, utcAt } from '../fixtures/scenarios/shared';

const NOW = utcAt(2026, 11, 27, 10, 0);

function eventWith(
  milestones: CommunityEventState['milestones'],
  communityHours: number,
): CommunityEventState {
  return {
    scrapedAt: isoAt(NOW),
    url: '/steam/community-event/infinity-nikki-community-event-1',
    title: 'Infinity Nikki',
    isLive: true,
    personalHours: 0,
    communityHours,
    communityHoursCap: 100_000,
    communityHoursSamples: [],
    communityHoursSource: 'asce',
    milestones,
    pendingArp: 0,
    awardedArp: 0,
    playEligibility: 'eligible',
  };
}

describe('Community Event non-ARP gates', () => {
  it('treats In-Game Bundle titles as non-ARP', () => {
    expect(isNonArpRewardLabel('In-Game Bundle 1')).toBe(true);
    expect(isNonArpRewardLabel('20 ARP')).toBe(false);
    expect(isNonArpRewardLabel('5 Fragments')).toBe(false);
  });

  it('does not inherit stale ARP onto an In-Game Bundle scrape', () => {
    const previous = eventWith(
      [
        {
          index: 1,
          personalHoursRequired: 1,
          communityHoursRequired: 10_000,
          arpReward: 20,
          rewardLabel: '20 ARP',
          isCommunityUnlocked: true,
          isAwarded: false,
        },
      ],
      12_339,
    );
    const scraped = eventWith(
      [
        {
          index: 1,
          personalHoursRequired: 1,
          communityHoursRequired: 10_000,
          arpReward: 0,
          rewardLabel: 'In-Game Bundle 1',
          isCommunityUnlocked: true,
          isAwarded: false,
        },
        {
          index: 2,
          personalHoursRequired: 2,
          communityHoursRequired: 20_000,
          arpReward: 20,
          rewardLabel: '20 ARP',
          isCommunityUnlocked: false,
          isAwarded: false,
        },
      ],
      12_339,
    );

    const merged = mergeCommunityEventScrape(scraped, previous);
    const bundle = merged.milestones.find(
      (milestone) => milestone.communityHoursRequired === 10_000,
    );
    expect(bundle?.rewardLabel).toBe('In-Game Bundle 1');
    expect(bundle?.arpReward).toBe(0);

    const pending = breakDownCommunityEventPending(merged);
    expect(pending.waitingPersonalArp).toBe(0);
  });

  it('does not fill ASCE ARP onto an In-Game Bundle at the same hours', () => {
    const milestones = upsertCommunityEventMilestoneGates(
      [
        {
          index: 1,
          personalHoursRequired: 1,
          communityHoursRequired: 10_000,
          arpReward: 0,
          rewardLabel: 'In-Game Bundle 1',
          isCommunityUnlocked: true,
          isAwarded: false,
        },
      ],
      [
        {
          hours: 10_000,
          arpReward: 20,
          label: '20 ARP',
          unlocked: true,
        },
        {
          hours: 20_000,
          arpReward: 20,
          label: '20 ARP',
          unlocked: false,
        },
      ],
    );

    const bundle = milestones.find(
      (milestone) => milestone.communityHoursRequired === 10_000,
    );
    expect(bundle?.arpReward).toBe(0);
    expect(bundle?.rewardLabel).toBe('In-Game Bundle 1');

    const pending = breakDownCommunityEventPending(
      eventWith(milestones, 12_339),
    );
    expect(pending.waitingPersonalArp).toBe(0);
  });

  it('keeps first ARP gated on community hours with ASCE at ~12k', () => {
    const event = eventWith(
      [
        {
          index: 1,
          personalHoursRequired: 1,
          communityHoursRequired: 10_000,
          arpReward: 0,
          rewardLabel: 'In-Game Bundle 1',
          isCommunityUnlocked: true,
          isAwarded: false,
        },
        {
          index: 2,
          personalHoursRequired: 2,
          communityHoursRequired: 20_000,
          arpReward: 20,
          rewardLabel: '20 ARP',
          isCommunityUnlocked: false,
          isAwarded: false,
        },
      ],
      12_339,
    );
    const pending = breakDownCommunityEventPending(event);
    expect(pending.waitingPersonalArp).toBe(0);
    expect(pending.waitingCommunityArp).toBe(0);
    expect(pending.imminentArp).toBe(0);
  });

  it('clears sticky community-unlocks when live hours are still below the gate', () => {
    // Regression: "145 ARP unlocked — play 6h more (3h / 9h)" when only the
    // 10k bundle was actually unlocked (~12k community hours).
    const sticky = [
      {
        index: 1,
        personalHoursRequired: 1,
        communityHoursRequired: 10_000,
        arpReward: 0,
        rewardLabel: 'In-Game Bundle 1',
        isCommunityUnlocked: true,
        isAwarded: false,
      },
      {
        index: 2,
        personalHoursRequired: 2,
        communityHoursRequired: 20_000,
        arpReward: 20,
        rewardLabel: '20 ARP',
        isCommunityUnlocked: true,
        isAwarded: false,
      },
      {
        index: 3,
        personalHoursRequired: 3,
        communityHoursRequired: 30_000,
        arpReward: 20,
        rewardLabel: '20 ARP',
        isCommunityUnlocked: true,
        isAwarded: false,
      },
      {
        index: 4,
        personalHoursRequired: 4,
        communityHoursRequired: 40_000,
        arpReward: 20,
        rewardLabel: '20 ARP',
        isCommunityUnlocked: true,
        isAwarded: false,
      },
      {
        index: 6,
        personalHoursRequired: 6,
        communityHoursRequired: 60_000,
        arpReward: 20,
        rewardLabel: '20 ARP',
        isCommunityUnlocked: true,
        isAwarded: false,
      },
      {
        index: 7,
        personalHoursRequired: 7,
        communityHoursRequired: 70_000,
        arpReward: 35,
        rewardLabel: '35 ARP',
        isCommunityUnlocked: true,
        isAwarded: false,
      },
      {
        index: 8,
        personalHoursRequired: 8,
        communityHoursRequired: 80_000,
        arpReward: 35,
        rewardLabel: '35 ARP',
        isCommunityUnlocked: true,
        isAwarded: false,
      },
      {
        index: 9,
        personalHoursRequired: 9,
        communityHoursRequired: 90_000,
        arpReward: 35,
        rewardLabel: '35 ARP',
        isCommunityUnlocked: true,
        isAwarded: false,
      },
    ];
    const cleared = applyCommunityHoursUnlocks(sticky, 12_339);
    expect(
      cleared.filter((milestone) => milestone.isCommunityUnlocked).map(
        (milestone) => milestone.communityHoursRequired,
      ),
    ).toEqual([10_000]);

    const pending = breakDownCommunityEventPending({
      ...eventWith(cleared, 12_339),
      personalHours: 3,
    });
    expect(pending.waitingPersonalArp).toBe(0);
  });

  it('does not keep previous unlock when the scrape shows the gate locked', () => {
    const previous = eventWith(
      [
        {
          index: 2,
          personalHoursRequired: 2,
          communityHoursRequired: 20_000,
          arpReward: 20,
          rewardLabel: '20 ARP',
          isCommunityUnlocked: true,
          isAwarded: false,
        },
      ],
      12_339,
    );
    const scraped = eventWith(
      [
        {
          index: 2,
          personalHoursRequired: 2,
          communityHoursRequired: 20_000,
          arpReward: 20,
          rewardLabel: '20 ARP',
          isCommunityUnlocked: false,
          isAwarded: false,
        },
      ],
      12_339,
    );
    const merged = mergeCommunityEventScrape(scraped, previous);
    const arp20 = merged.milestones.find(
      (milestone) => milestone.communityHoursRequired === 20_000,
    );
    expect(arp20?.isCommunityUnlocked).toBe(false);
  });
});
