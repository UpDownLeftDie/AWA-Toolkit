import { describe, expect, it, vi } from 'vitest';

import { ArtifactTier } from '../../src/artifacts/data';
import { buildContext } from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import { scoreCombo } from '../../src/artifacts/optimizer/scoring';
import type { OptimizerResult } from '../../src/artifacts/optimizer/types';
import {
  COOLDOWN_MS,
  defaultArtifactSettings,
} from '../../src/artifacts/settings';
import { buildActionPlan } from '../../src/artifacts/ui/actionPlan';
import { makeArtifact, makeSnapshot } from '../fixtures/artifactFactory';
import { isoAt, utcAt } from '../fixtures/scenarios/shared';

const AFTER_POLL_POST = utcAt(2026, 8, 10, 16, 50);

function discordDueState(nowMs: number) {
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
  };
}

describe('Discord Poll action-plan order', () => {
  it('lists the waiting Discord equip before the vote that needs it', () => {
    vi.stubGlobal('location', { pathname: '/ucf/Giveaway' });
    const nowMs = AFTER_POLL_POST;
    const chai = makeArtifact('chai-stones', ArtifactTier.Interstellar, {
      equippedPosition: 1,
    });
    const standing = makeArtifact('pn295', ArtifactTier.Interstellar, {
      equippedPosition: 2,
      slotLocked: true,
    });
    const bali = makeArtifact('bali-arches', ArtifactTier.Interstellar, {
      equippedPosition: 3,
    });
    const discordPiece = makeArtifact(
      'zorathian-cosmotheque',
      ArtifactTier.Gold,
    );
    const snapshot = makeSnapshot([chai, standing, bali, discordPiece], {
      slotLocks: { 2: true },
    });
    const settings = {
      ...defaultArtifactSettings,
      slotCooldowns: [
        {
          position: 2 as const,
          changedAt: new Date(nowMs - (COOLDOWN_MS - 2 * 3_600_000)).toISOString(),
          estimated: true,
        },
      ],
    };
    const siteState = discordDueState(nowMs);
    const context = buildContext(snapshot, settings, siteState, nowMs);
    const current = scoreCombo([chai, standing, bali], context);
    const best = scoreCombo([chai, discordPiece, bali], context);
    const result: OptimizerResult = {
      best,
      current,
      alternatives: [],
      upgrades: [],
      slotLocks: { 2: true },
      dailySwap: undefined,
      notes: [],
    };

    const todos = buildActionPlan(result, settings, siteState);
    const numbered = todos.filter((todo) => todo.kind !== 'caution');
    const texts = numbered.map((todo) => todo.text);

    expect(texts[0]).toMatch(/^Equip (now|in )/);
    expect(numbered[0]?.loadout).toMatch(/5th Dimensional Data/);
    expect(texts[1]).toBe('Vote Discord Poll');
    expect(numbered[1]?.reasons?.map((reason) => reason.text)).toEqual([
      'After equipping',
    ]);
    expect(texts[1]).not.toMatch(/after unlock/i);
    expect(texts[1]).not.toMatch(/next post/i);
  });

  it('still recommends the Discord equip after the GM timer hits 0 while Showroom is locked', () => {
    vi.stubGlobal('location', { pathname: '/ucf/Giveaway' });
    const nowMs = AFTER_POLL_POST;
    const snapshot = makeSnapshot(
      [
        makeArtifact('chai-stones', ArtifactTier.Interstellar, {
          equippedPosition: 1,
        }),
        makeArtifact('bali-arches', ArtifactTier.Platinum, {
          equippedPosition: 2,
          slotLocked: true,
        }),
        makeArtifact('pn295', ArtifactTier.Interstellar, {
          equippedPosition: 3,
        }),
        makeArtifact('zorathian-cosmotheque', ArtifactTier.Gold),
      ],
      { slotLocks: { 2: true } },
    );
    const settings = {
      ...defaultArtifactSettings,
      slotCooldowns: [
        {
          position: 2 as const,
          changedAt: new Date(nowMs - COOLDOWN_MS).toISOString(),
          estimated: true,
        },
      ],
    };
    const siteState = discordDueState(nowMs);
    const result = optimize(
      buildContext(snapshot, settings, siteState, nowMs),
    );
    const todos = buildActionPlan(result, settings, siteState);
    const numbered = todos.filter((todo) => todo.kind !== 'caution');
    const texts = numbered.map((todo) => todo.text);
    const equipIndex = numbered.findIndex(
      (todo) =>
        todo.urgency?.chain === 'equip' &&
        /5th Dimensional Data/i.test(todo.loadout ?? ''),
    );
    const voteIndex = texts.indexOf('Vote Discord Poll');

    expect(result.best?.artifacts.map((artifact) => artifact.familyId)).toContain(
      'zorathian-cosmotheque',
    );
    expect(equipIndex).toBeGreaterThanOrEqual(0);
    expect(voteIndex).toBeGreaterThan(equipIndex);
    expect(numbered[voteIndex]?.reasons?.map((reason) => reason.text)).toEqual([
      'After equipping',
    ]);
    const stuckCaution = todos.find(
      (todo) =>
        todo.kind === 'caution' &&
        /timer hit 0/i.test(todo.text) &&
        todo.reasons?.some((reason) => /Warrior Script/i.test(reason.text)),
    );
    expect(stuckCaution).toBeDefined();
  });
});
