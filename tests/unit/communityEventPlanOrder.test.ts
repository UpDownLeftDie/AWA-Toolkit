import { describe, expect, it, vi } from 'vitest';

import { ArtifactTier } from '../../src/artifacts/data';
import { buildContext } from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import { buildActionPlan } from '../../src/artifacts/ui/actionPlan';
import { makeArtifact, makeSnapshot } from '../fixtures/artifactFactory';
import { isoAt, utcAt } from '../fixtures/scenarios/shared';

const MIDDAY = utcAt(2026, 9, 15, 17, 0);

function allArpOwnedUnequippedSnapshot() {
  return makeSnapshot([
    makeArtifact('bali-arches', ArtifactTier.Interstellar, {
      equippedPosition: 1,
    }),
    makeArtifact('chai-stones', ArtifactTier.Interstellar, {
      equippedPosition: 2,
    }),
    makeArtifact('pn295', ArtifactTier.Interstellar, {
      equippedPosition: 3,
    }),
    makeArtifact('zorathian-cosmotheque', ArtifactTier.Gold),
    makeArtifact('flux', ArtifactTier.Interstellar),
    makeArtifact('herkow-plasma-chamber', ArtifactTier.Interstellar),
  ]);
}

describe('Community Event action-plan order', () => {
  it('keeps Community Event hours after Equip All-ARP% (and after Twitch)', () => {
    vi.stubGlobal('location', { pathname: '/ucf/Giveaway' });
    const nowMs = MIDDAY;
    const snapshot = allArpOwnedUnequippedSnapshot();
    const settings = defaultArtifactSettings;
    const state = {
      capsScrapedAt: isoAt(nowMs),
      caps: {
        timeOnSite: 'capped' as const,
        watchTwitch: 'available' as const,
        dailyCalendar: 'capped' as const,
        dailyQuests: 'capped' as const,
        discordPoll: 'capped' as const,
        steamCommunityEvent: 'available' as const,
        steamQuests: 'capped' as const,
      },
      gameVault: [],
      watchTwitch: {
        scrapedAt: isoAt(nowMs),
        baseArp: 0,
        bonusArp: 0,
        timeWatched: 0,
        isUnderCap: true,
        capArp: 15,
        remainingMs: 2 * 3_600_000,
      },
      communityEvent: {
        scrapedAt: isoAt(nowMs),
        url: '/steam/community-event/test',
        title: 'Test Community Event',
        isLive: true,
        personalHours: 10,
        communityHours: 80_000,
        communityHoursCap: 150_000,
        communityHoursSamples: [],
        communityHoursSource: 'asce' as const,
        milestones: [
          {
            index: 0,
            personalHoursRequired: 50,
            communityHoursRequired: 50_000,
            arpReward: 125,
            rewardLabel: '125 ARP',
            isCommunityUnlocked: true,
            isAwarded: false,
          },
        ],
        pendingArp: 125,
        awardedArp: 0,
        playEligibility: 'eligible' as const,
      },
    };

    const result = optimize(buildContext(snapshot, settings, state, nowMs));
    expect(result.hasAllArpOwned).toBe(true);
    expect(result.hasAllArpEquipped).toBe(false);

    const todos = buildActionPlan(result, settings, state, nowMs);
    const numbered = todos.filter((todo) => todo.kind !== 'caution');
    const twitchIdx = numbered.findIndex((todo) => /Watch Twitch/i.test(todo.text));
    const equipIdx = numbered.findIndex((todo) =>
      /Equip All-ARP% before playing more Community Event/i.test(todo.text),
    );
    const ceIdx = numbered.findIndex(
      (todo) =>
        /Community Event/i.test(todo.text) && !/Equip All-ARP%/i.test(todo.text),
    );

    expect(twitchIdx).toBeGreaterThanOrEqual(0);
    expect(equipIdx).toBeGreaterThanOrEqual(0);
    expect(ceIdx).toBeGreaterThanOrEqual(0);
    expect(numbered[ceIdx]?.urgency?.chain).toBe('after');
    // Play CE hours only after the All-ARP% guard.
    expect(equipIdx).toBeLessThan(ceIdx);
    // Twitch stays ahead of CE hours; it may sit before or after the equip
    // step depending on whether All-ARP% boosts the remaining watch window.
    expect(twitchIdx).toBeLessThan(ceIdx);
    if (numbered[twitchIdx]?.urgency?.chain === 'before') {
      expect(twitchIdx).toBeLessThan(equipIdx);
    } else {
      expect(equipIdx).toBeLessThan(twitchIdx);
    }
  });

});
