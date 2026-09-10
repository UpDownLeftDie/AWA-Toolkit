import { describe, expect, it, vi } from 'vitest';

import { ArtifactTier, BASE_ACTIVITY } from '../../src/artifacts/data';
import { buildContext } from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import { buildActionPlan } from '../../src/artifacts/ui/actionPlan';
import { makeArtifact, makeSnapshot } from '../fixtures/artifactFactory';
import { isoAt, utcAt } from '../fixtures/scenarios/shared';

const MONDAY_AFTER_RESET = utcAt(2026, 7, 24, 3, 10);

function pendingSteamTwitchState(nowMs: number) {
  return {
    updatedAt: isoAt(nowMs),
    caps: {
      timeOnSite: 'capped' as const,
      watchTwitch: 'available' as const,
      dailyCalendar: 'capped' as const,
      dailyQuests: 'capped' as const,
      discordPoll: 'capped' as const,
      steamCommunityEvent: 'unknown' as const,
      steamQuests: 'available' as const,
    },
    gameVault: [],
    watchTwitch: {
      scrapedAt: isoAt(nowMs),
      baseArp: 13,
      bonusArp: 0,
      timeWatched: 13,
      isUnderCap: true,
      capArp: BASE_ACTIVITY.watchTwitchBasePerDay,
      remainingMs: 17 * 60_000,
    },
    steamQuests: {
      scrapedAt: isoAt(nowMs),
      quests: [
        {
          name: 'Q1',
          rewardArp: 15,
          status: 'incomplete' as const,
          eligibility: 'eligible' as const,
        },
        {
          name: 'Q2',
          rewardArp: 25,
          status: 'incomplete' as const,
          eligibility: 'eligible' as const,
        },
        {
          name: 'Q3',
          rewardArp: 25,
          status: 'incomplete' as const,
          eligibility: 'eligible' as const,
        },
      ],
    },
  };
}

describe('Steam lock vs daily Twitch', () => {
  it('finishes Twitch on Collapsed Star before locking the Steam set', () => {
    vi.stubGlobal('location', { pathname: '/ucf/Giveaway' });
    const nowMs = MONDAY_AFTER_RESET;
    const snapshot = makeSnapshot(
      [
        makeArtifact('chai-stones', ArtifactTier.Interstellar, {
          equippedPosition: 1,
          slotLocked: true,
        }),
        makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar, {
          equippedPosition: 2,
        }),
        makeArtifact('pn295', ArtifactTier.Interstellar, {
          equippedPosition: 3,
        }),
        makeArtifact('sylphin-fission-blade', ArtifactTier.Interstellar),
        makeArtifact('scion-of-the-light', ArtifactTier.Bronze),
      ],
      { slotLocks: { 1: true } },
    );
    const siteState = pendingSteamTwitchState(nowMs);
    const context = buildContext(
      snapshot,
      defaultArtifactSettings,
      siteState,
      nowMs,
    );
    const result = optimize(context);
    const bestIds = result.best?.artifacts.map((artifact) => artifact.familyId) ?? [];
    const todos = buildActionPlan(result, defaultArtifactSettings, siteState);
    const texts = todos.map((todo) => todo.text);

    expect(bestIds).toContain('pn295-unstable-battery');
    expect(bestIds).toContain('sylphin-fission-blade');
    expect(bestIds).not.toContain('scion-of-the-light');
    expect(result.deferredSteam).toBeUndefined();
    expect(result.notes.some((note) => /finish them before swapping/i.test(note))).toBe(
      false,
    );

    const twitchIndex = texts.findIndex((text) => /watch twitch/i.test(text));
    const steamNowIndex = texts.findIndex((text) =>
      /equip steam quests set now/i.test(text),
    );
    const steamLockIndex = todos.findIndex(
      (todo) =>
        todo.urgency?.chain === 'equip' &&
        (todo.urgency.readyAtMs ?? 0) === 0 &&
        /recycler|fission blade/i.test(`${todo.text} ${todo.loadout ?? ''}`),
    );
    const steamQuestIndex = texts.findIndex((text) =>
      /complete \d+ steam quest/i.test(text),
    );
    expect(twitchIndex).toBeGreaterThanOrEqual(0);
    expect(texts[twitchIndex]).toMatch(/before swapping/i);
    expect(texts[twitchIndex]).not.toMatch(/00:00 UTC/i);
    expect(steamNowIndex).toBe(-1);
    expect(steamLockIndex).toBeGreaterThan(twitchIndex);
    if (steamQuestIndex >= 0) {
      expect(steamQuestIndex).toBeGreaterThan(twitchIndex);
    }
  });

  it('does not lock Warrior Script over Collapsed Star for +1 Steam', () => {
    vi.stubGlobal('location', { pathname: '/ucf/Giveaway' });
    const nowMs = MONDAY_AFTER_RESET;
    const snapshot = makeSnapshot([
      makeArtifact('chai-stones', ArtifactTier.Interstellar, {
        equippedPosition: 1,
      }),
      makeArtifact('pn295', ArtifactTier.Interstellar, {
        equippedPosition: 2,
      }),
      makeArtifact('flux', ArtifactTier.Interstellar, {
        equippedPosition: 3,
      }),
      makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar),
      makeArtifact('sylphin-fission-blade', ArtifactTier.Interstellar),
      makeArtifact('herkow-warrior-script', ArtifactTier.Rust),
    ]);
    const siteState = pendingSteamTwitchState(nowMs);
    const context = buildContext(
      snapshot,
      defaultArtifactSettings,
      siteState,
      nowMs,
    );
    const result = optimize(context);
    const bestIds = result.best?.artifacts.map((artifact) => artifact.familyId) ?? [];
    const todos = buildActionPlan(result, defaultArtifactSettings, siteState);
    const reasonText = todos
      .flatMap((todo) => [
        todo.text,
        todo.loadout ?? '',
        ...(todo.reasons ?? []).flatMap((reason) => [
          reason.text,
          reason.detail ?? '',
        ]),
      ])
      .join('\n');

    expect(bestIds).toContain('pn295');
    expect(bestIds).toContain('pn295-unstable-battery');
    expect(bestIds).toContain('sylphin-fission-blade');
    expect(bestIds).not.toContain('herkow-warrior-script');
    expect(result.deferredSteam).toBeUndefined();
    expect(reasonText).not.toMatch(/warrior script/i);
    expect(reasonText).toMatch(/\+27 steam/i);
  });
});
