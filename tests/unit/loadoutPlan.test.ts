import { describe, expect, it } from 'vitest';

import { ArtifactTier } from '../../src/artifacts/data';
import type { ScoredCombo } from '../../src/artifacts/optimizer/types';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import { planLoadoutChanges } from '../../src/artifacts/ui/loadoutPlan';
import { makeArtifact } from '../fixtures/artifactFactory';

function asCurrent(
  artifacts: ScoredCombo['artifacts'],
): ScoredCombo {
  return { artifacts } as ScoredCombo;
}

describe('planLoadoutChanges', () => {
  it('fills a free slot now and leaves the rest for locked slots', () => {
    const current = asCurrent([
      makeArtifact('chai-stones', ArtifactTier.Interstellar, {
        equippedPosition: 1,
        slotLocked: true,
      }),
      makeArtifact('flux', ArtifactTier.Interstellar, {
        equippedPosition: 2,
      }),
      makeArtifact('bali-arches', ArtifactTier.Interstellar, {
        equippedPosition: 3,
        slotLocked: true,
      }),
    ]);
    const combo = [
      makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar),
      makeArtifact('sylphin-fission-blade', ArtifactTier.Interstellar),
      makeArtifact('pn295', ArtifactTier.Interstellar),
    ];
    const nowMs = Date.now();
    const settings = {
      ...defaultArtifactSettings,
      slotCooldowns: ([1, 3] as const).map((position) => ({
        position,
        changedAt: new Date(nowMs - 12 * 3_600_000).toISOString(),
        estimated: true as const,
      })),
    };
    const plan = planLoadoutChanges(combo, current, settings, {
      1: true,
      3: true,
    });

    expect(plan.now).toHaveLength(1);
    expect(plan.later).toHaveLength(2);
    const names = [...plan.now, ...plan.later].map((change) => change.displayName);
    expect(names.sort()).toEqual(combo.map((artifact) => artifact.displayName).sort());
  });

  it('equips all remaining pieces in one shot when every slot is free', () => {
    const recycler = makeArtifact(
      'pn295-unstable-battery',
      ArtifactTier.Interstellar,
    );
    const blade = makeArtifact(
      'sylphin-fission-blade',
      ArtifactTier.Interstellar,
    );
    const star = makeArtifact('pn295', ArtifactTier.Interstellar);
    const current = asCurrent([
      makeArtifact('chai-stones', ArtifactTier.Interstellar, {
        equippedPosition: 1,
      }),
      makeArtifact('flux', ArtifactTier.Interstellar, {
        equippedPosition: 2,
      }),
      makeArtifact('bali-arches', ArtifactTier.Interstellar, {
        equippedPosition: 3,
      }),
    ]);
    const plan = planLoadoutChanges(
      [recycler, blade, star],
      current,
      defaultArtifactSettings,
    );

    expect(plan.later).toHaveLength(0);
    expect(plan.now).toHaveLength(3);
    expect(plan.now.map((change) => change.displayName).sort()).toEqual(
      [recycler, blade, star].map((artifact) => artifact.displayName).sort(),
    );
  });

  it('equips all remaining pieces at once when they fit in free slots', () => {
    const star = makeArtifact('pn295', ArtifactTier.Interstellar, {
      equippedPosition: 2,
      slotLocked: true,
    });
    const recycler = makeArtifact(
      'pn295-unstable-battery',
      ArtifactTier.Interstellar,
    );
    const blade = makeArtifact(
      'sylphin-fission-blade',
      ArtifactTier.Interstellar,
    );
    const current = asCurrent([
      makeArtifact('chai-stones', ArtifactTier.Interstellar, {
        equippedPosition: 1,
      }),
      star,
      makeArtifact('flux', ArtifactTier.Interstellar, {
        equippedPosition: 3,
      }),
    ]);
    const plan = planLoadoutChanges(
      [recycler, blade, star],
      current,
      defaultArtifactSettings,
      { 2: true },
    );

    expect(plan.later).toHaveLength(0);
    expect(plan.now.map((change) => change.displayName).sort()).toEqual(
      [recycler.displayName, blade.displayName].sort(),
    );
  });
});
