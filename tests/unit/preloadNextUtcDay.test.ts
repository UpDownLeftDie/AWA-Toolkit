import { describe, expect, it } from 'vitest';

import { buildContext } from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import { findBestCombo } from '../../src/artifacts/optimizer/search';
import { resolveOwnedList } from '../../src/artifacts/optimizer/context';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import { buildActionPlan } from '../../src/artifacts/ui/actionPlan';
import type { ArtifactSnapshot, OwnedArtifact } from '../../src/artifacts/scraper';
import { midTwitchFocus } from '../fixtures/personas/index';
import { steamWeekComplete } from '../fixtures/scenarios/baseline';
import { utcAt } from '../fixtures/scenarios/shared';

const SAT_23 = utcAt(2026, 7, 22, 23, 0);
const SAT_12 = utcAt(2026, 7, 22, 12, 0);
const SUN_00 = utcAt(2026, 7, 23, 0, 0);

function familyIds(artifacts: OwnedArtifact[] | undefined): string[] {
  return artifacts?.map((artifact) => artifact.familyId) ?? [];
}

function equipLoadout(
  snapshot: ArtifactSnapshot,
  loadout: OwnedArtifact[],
): ArtifactSnapshot {
  const byId = new Map(
    loadout.map((artifact, index) => [artifact.instanceId, index + 1]),
  );
  return {
    ...snapshot,
    artifacts: snapshot.artifacts.map((artifact) => {
      const slot = byId.get(artifact.instanceId);
      if (slot === 1 || slot === 2 || slot === 3) {
        return { ...artifact, equippedPosition: slot };
      }
      const next = { ...artifact };
      delete next.equippedPosition;
      return next;
    }),
  };
}

describe('preload next UTC day loadout', () => {
  it('Saturday 23:00 UTC recommends Recycler so the Monday steam lock starts now', () => {
    const siteState = steamWeekComplete(0, SAT_23);
    const context = buildContext(
      midTwitchFocus.snapshot,
      defaultArtifactSettings,
      siteState,
      SAT_23,
    );
    const owned = resolveOwnedList(context);
    const withoutPreload = findBestCombo(owned, context);
    expect(familyIds(withoutPreload?.artifacts)).not.toContain(
      'pn295-unstable-battery',
    );

    const result = optimize(context);
    expect(result.preloadNextUtcDay).toBe(true);
    expect(familyIds(result.best?.artifacts)).toContain(
      'pn295-unstable-battery',
    );

    const todos = buildActionPlan(result, defaultArtifactSettings, siteState);
    const equip = todos.find((todo) => todo.urgency?.chain === 'equip');
    expect(equip).toBeDefined();
    expect(equip?.loadout).toMatch(/Recycler/i);
    expect(equip?.reasons?.some((reason) => /24h lock before 00:00 UTC/i.test(reason.text))).toBe(
      true,
    );
  });

  it('Sunday 00:00 UTC still recommends Recycler without the preload flag', () => {
    const siteState = steamWeekComplete(0, SUN_00);
    const context = buildContext(
      midTwitchFocus.snapshot,
      defaultArtifactSettings,
      siteState,
      SUN_00,
    );
    const result = optimize(context);
    expect(familyIds(result.best?.artifacts)).toContain(
      'pn295-unstable-battery',
    );
    expect(result.preloadNextUtcDay).toBeUndefined();
  });

  it('Saturday 12:00 UTC does not preload while ToS / Twitch still fit today', () => {
    const siteState = steamWeekComplete(0, SAT_12);
    const context = buildContext(
      midTwitchFocus.snapshot,
      defaultArtifactSettings,
      siteState,
      SAT_12,
    );
    const result = optimize(context);
    expect(result.preloadNextUtcDay).toBeUndefined();
    expect(familyIds(result.best?.artifacts)).not.toContain(
      'pn295-unstable-battery',
    );
  });

  it('Saturday 23:00 UTC already on Recycler does not swap off for the idle Twitch set', () => {
    const sundayState = steamWeekComplete(0, SUN_00);
    const sundayContext = buildContext(
      midTwitchFocus.snapshot,
      defaultArtifactSettings,
      sundayState,
      SUN_00,
    );
    const sundayBest = findBestCombo(
      resolveOwnedList(sundayContext),
      sundayContext,
    );
    expect(sundayBest).toBeDefined();

    const wearingRecycler = equipLoadout(
      midTwitchFocus.snapshot,
      sundayBest!.artifacts,
    );
    const siteState = steamWeekComplete(0, SAT_23);
    const context = buildContext(
      wearingRecycler,
      defaultArtifactSettings,
      siteState,
      SAT_23,
    );
    const result = optimize(context);
    expect(familyIds(result.best?.artifacts)).toContain(
      'pn295-unstable-battery',
    );
    expect(familyIds(result.current?.artifacts)).toContain(
      'pn295-unstable-battery',
    );
    expect(result.dailySwap).toBeUndefined();
  });
});
