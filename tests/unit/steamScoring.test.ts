import { describe, expect, it } from 'vitest';

import { buildContext } from '../../src/artifacts/optimizer/context';
import { scoreCombo } from '../../src/artifacts/optimizer/scoring';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import { midTwitchFocus } from '../fixtures/personas/index';
import { steamWeekComplete } from '../fixtures/scenarios/baseline';
import { baselineScenario } from '../fixtures/scenarios/baseline';
import { wednesdayMidWeekSteamCompleteMs } from '../fixtures/timeGrid';

describe('scoreCombo steam scoring', () => {
  const nowMs = wednesdayMidWeekSteamCompleteMs();

  it('capped steam week → no steamQuests breakdown on Twitch loadout', () => {
    const siteState = steamWeekComplete(0, nowMs);
    const context = buildContext(
      midTwitchFocus.snapshot,
      defaultArtifactSettings,
      siteState,
      nowMs,
    );
    const owned = context.snapshot.artifacts.filter(
      (artifact) => artifact.equippedPosition !== undefined,
    );
    const scored = scoreCombo(owned, context, 0);
    expect(scored.breakdown.steamQuests?.total ?? 0).toBe(0);
  });

  it('unknown caps without scraped quests → no invented 15+25+25', () => {
    const siteState = baselineScenario(0, nowMs);
    const context = buildContext(
      midTwitchFocus.snapshot,
      defaultArtifactSettings,
      siteState,
      nowMs,
    );
    const recycler = context.snapshot.artifacts.find(
      (artifact) => artifact.familyId === 'pn295-unstable-battery',
    );
    expect(recycler).toBeDefined();
    const scored = scoreCombo([recycler!], context, 0);
    expect(scored.breakdown.steamQuests?.total ?? 0).toBe(0);
  });

  it('Monday inside wear window can count next-week steam bases', () => {
    const sundayMs = Date.UTC(2026, 7, 9, 20, 0);
    const siteState = baselineScenario(0, sundayMs);
    siteState.steamQuests = {
      scrapedAt: new Date(sundayMs).toISOString(),
      quests: [
        {
          name: 'Q1',
          rewardArp: 15,
          status: 'incomplete',
          eligibility: 'eligible',
        },
        {
          name: 'Q2',
          rewardArp: 25,
          status: 'incomplete',
          eligibility: 'eligible',
        },
        {
          name: 'Q3',
          rewardArp: 25,
          status: 'incomplete',
          eligibility: 'eligible',
        },
      ],
    };
    const context = buildContext(
      midTwitchFocus.snapshot,
      defaultArtifactSettings,
      siteState,
      sundayMs,
    );
    const recycler = context.snapshot.artifacts.find(
      (artifact) => artifact.familyId === 'pn295-unstable-battery',
    );
    const waitMs = 0;
    const scored = scoreCombo([recycler!], context, waitMs);
    expect(scored.breakdown.steamQuests?.base ?? 0).toBeGreaterThan(0);
  });
});
