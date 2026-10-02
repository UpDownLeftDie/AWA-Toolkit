import { describe, expect, it, vi } from 'vitest';

import { ArtifactTier } from '../../src/artifacts/data';
import { buildContext } from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import { buildActionPlan } from '../../src/artifacts/ui/actionPlan';
import { makeArtifact, makeSnapshot } from '../fixtures/artifactFactory';
import { isoAt, utcAt } from '../fixtures/scenarios/shared';

const AFTER_POLL_POST = utcAt(2026, 9, 15, 17, 0);

function siteState(nowMs: number, battlePass: {
  readyToClaim: number;
  readyToClaimArp: number;
  endsAt?: string;
}) {
  return {
    updatedAt: isoAt(nowMs),
    caps: {
      timeOnSite: 'capped' as const,
      watchTwitch: 'capped' as const,
      dailyCalendar: 'capped' as const,
      dailyQuests: 'capped' as const,
      discordPoll: 'available' as const,
      steamCommunityEvent: 'unknown' as const,
      steamQuests: 'capped' as const,
    },
    gameVault: [],
    battlePass: {
      url: '/control-center/battle-pass/1',
      scrapedAt: isoAt(nowMs),
      ...battlePass,
    },
  };
}

function midZorathianSnapshot() {
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

describe('Battle Pass action-plan order', () => {
  it('labels non-ARP claims clearly and holds ARP Boosts while All-ARP% is off', () => {
    vi.stubGlobal('location', { pathname: '/ucf/Giveaway' });
    const nowMs = AFTER_POLL_POST;
    // Season still has time → hold ARP Boosts; 1 cosmetic + 1 boost ready.
    const endsAt = new Date(nowMs + 14 * 86_400_000).toISOString();
    const snapshot = midZorathianSnapshot();
    const settings = defaultArtifactSettings;
    const state = siteState(nowMs, {
      readyToClaim: 2,
      readyToClaimArp: 1,
      endsAt,
    });
    const result = optimize(buildContext(snapshot, settings, state, nowMs));
    expect(result.deferBattlePassClaims).toBe(true);
    expect(result.hasAllArpOwned).toBe(true);
    expect(result.hasAllArpEquipped).toBe(false);

    const todos = buildActionPlan(result, settings, state);
    const numbered = todos.filter((todo) => todo.kind !== 'caution');
    const skipClaim = numbered.find(
      (todo) =>
        todo.claimBattlePass === true && todo.claimBattlePassSkipArp === true,
    );
    const fullClaim = numbered.find(
      (todo) =>
        todo.claimBattlePass === true && todo.claimBattlePassSkipArp !== true,
    );

    expect(skipClaim).toBeDefined();
    expect(fullClaim).toBeUndefined();
    expect(skipClaim?.text).toMatch(/cosmetic|fragment/i);
    expect(skipClaim?.text).toMatch(/not arp boost/i);
    expect(skipClaim?.reasons?.map((reason) => reason.text).join(' ')).toMatch(
      /does not claim.*arp boost/i,
    );
    expect(skipClaim?.urgency?.kind).toBe('action');
    expect(
      todos.some(
        (todo) =>
          todo.kind === 'caution' && /don't claim.*arp boost/i.test(todo.text),
      ),
    ).toBe(true);
  });

  it('claims ARP Boosts without All-ARP% only when the season ends first', () => {
    vi.stubGlobal('location', { pathname: '/ucf/Giveaway' });
    const nowMs = AFTER_POLL_POST;
    // Season ends before a 24h lock can finish.
    const endsAt = new Date(nowMs + 2 * 3_600_000).toISOString();
    const snapshot = midZorathianSnapshot();
    const settings = {
      ...defaultArtifactSettings,
      slotCooldowns: ([1, 2, 3] as const).map((position) => ({
        position,
        changedAt: new Date(nowMs - 12 * 3_600_000).toISOString(),
        estimated: true as const,
      })),
    };
    const lockedSnapshot = makeSnapshot(snapshot.artifacts, {
      slotLocks: { 1: true, 2: true, 3: true },
    });
    for (const artifact of lockedSnapshot.artifacts) {
      if (artifact.equippedPosition !== undefined) {
        artifact.slotLocked = true;
      }
    }
    const state = siteState(nowMs, {
      readyToClaim: 1,
      readyToClaimArp: 1,
      endsAt,
    });
    const result = optimize(
      buildContext(lockedSnapshot, settings, state, nowMs),
    );
    expect(result.deferBattlePassClaims).toBe(false);

    const todos = buildActionPlan(result, settings, state);
    const claim = todos.find(
      (todo) =>
        todo.claimBattlePass === true && todo.claimBattlePassSkipArp !== true,
    );
    expect(claim?.text).toMatch(/ends before All-ARP%/i);
  });
});
