import { describe, expect, it } from 'vitest';

import { ArtifactTier } from '../../src/artifacts/data';
import { buildContext } from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import { VAULT_PRIORITY_DISCOUNT_PCT } from '../../src/artifacts/optimizer/search';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import {
  isGameVaultDiscountWindow,
  isVaultItemPurchasable,
} from '../../src/artifacts/siteState/gameVault';
import type { SiteState } from '../../src/artifacts/siteState/types';
import {
  makeArtifact,
  makeSnapshot,
  resetArtifactIds,
} from '../fixtures/artifactFactory';
import { isoAt, utcAt } from '../fixtures/scenarios/shared';

const NOW_MS = utcAt(2026, 7, 21, 16, 0);

function vaultOpenState(
  overrides: Partial<SiteState> = {},
): SiteState {
  return {
    updatedAt: isoAt(NOW_MS),
    caps: {
      timeOnSite: 'available',
      watchTwitch: 'available',
      dailyCalendar: 'available',
      dailyQuests: 'available',
      discordPoll: 'available',
      steamCommunityEvent: 'unknown',
      steamQuests: 'capped',
    },
    gameVault: [
      {
        name: 'Vault Game',
        price: 500,
        inStock: true,
        purchasable: true,
      },
    ],
    gameVaultOpensAt: isoAt(NOW_MS - 60_000),
    arpLog: {
      scrapedAt: isoAt(NOW_MS),
      redeemableArp: 2000,
      recent: [],
    },
    ...overrides,
  };
}

function familyIds(result: ReturnType<typeof optimize>): string[] {
  return result.best?.artifacts.map((artifact) => artifact.familyId) ?? [];
}

describe('isVaultItemPurchasable / discount window', () => {
  it('treats countdown-disabled stock as purchasable once opensAt has passed', () => {
    const game = {
      name: 'Vault Game',
      price: 500,
      inStock: true,
      purchasable: false as const,
    };
    const state = vaultOpenState({
      gameVault: [game],
    });
    expect(isVaultItemPurchasable(game, state, NOW_MS)).toBe(true);
    expect(isGameVaultDiscountWindow(state, NOW_MS)).toBe(true);
  });

  it('stays closed while the countdown is still running', () => {
    const game = {
      name: 'Vault Game',
      price: 500,
      inStock: true,
      purchasable: false as const,
    };
    const state = vaultOpenState({
      gameVault: [game],
      gameVaultOpensAt: isoAt(NOW_MS + 3_600_000),
    });
    expect(isVaultItemPurchasable(game, state, NOW_MS)).toBe(false);
    expect(isGameVaultDiscountWindow(state, NOW_MS)).toBe(false);
  });
});

describe('vault-open optimizer recommendation', () => {
  it('keeps a 10% market-discount set while Game Vault is open', () => {
    resetArtifactIds(6000);
    const snapshot = makeSnapshot([
      makeArtifact('light-warping', ArtifactTier.Platinum, {
        equippedPosition: 1,
      }),
      makeArtifact('chai-stones', ArtifactTier.Interstellar, {
        equippedPosition: 2,
      }),
      makeArtifact('pn295', ArtifactTier.Interstellar, {
        equippedPosition: 3,
      }),
      makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar),
    ]);
    const result = optimize(
      buildContext(snapshot, defaultArtifactSettings, vaultOpenState(), NOW_MS),
    );
    expect(familyIds(result)).toContain('light-warping');
    expect(familyIds(result)).not.toContain('pn295-unstable-battery');
    expect(result.best?.marketDiscountPct).toBeGreaterThanOrEqual(0.1);
  });

  it('recommends swapping a free slot onto 10% discount instead of staying on the ARP set', () => {
    resetArtifactIds(6100);
    const chai = makeArtifact('chai-stones', ArtifactTier.Interstellar, {
      equippedPosition: 1,
      slotLocked: false,
    });
    const recycler = makeArtifact(
      'pn295-unstable-battery',
      ArtifactTier.Interstellar,
      { equippedPosition: 2, slotLocked: true },
    );
    const collapsed = makeArtifact('pn295', ArtifactTier.Interstellar, {
      equippedPosition: 3,
      slotLocked: true,
    });
    const lightWarping = makeArtifact('light-warping', ArtifactTier.Platinum);
    const snapshot = makeSnapshot(
      [chai, recycler, collapsed, lightWarping],
      { slotLocks: { 2: true, 3: true } },
    );
    const result = optimize(
      buildContext(snapshot, defaultArtifactSettings, vaultOpenState(), NOW_MS),
    );
    expect(familyIds(result)).toContain('light-warping');
    expect(result.best?.marketDiscountPct).toBeGreaterThanOrEqual(0.1);
    expect(result.current?.marketDiscountPct ?? 0).toBe(0);
    expect(result.vaultDiscount?.note).toMatch(/Equip market-discount/i);
  });

  it('does not interrupt ARP for a weak Decipher-only (2%) discount', () => {
    resetArtifactIds(6150);
    const recycler = makeArtifact(
      'pn295-unstable-battery',
      ArtifactTier.Interstellar,
      { equippedPosition: 1, slotLocked: true },
    );
    const collapsed = makeArtifact('pn295', ArtifactTier.Interstellar, {
      equippedPosition: 3,
      slotLocked: true,
    });
    // Stronger ARP filler for the free slot than Decipher's 2% vault tease.
    const chai = makeArtifact('chai-stones', ArtifactTier.Interstellar);
    const decipher = makeArtifact('mysterious-text', ArtifactTier.Bronze);
    const snapshot = makeSnapshot([recycler, collapsed, chai, decipher], {
      slotLocks: { 1: true, 3: true },
    });
    const result = optimize(
      buildContext(snapshot, defaultArtifactSettings, vaultOpenState(), NOW_MS),
    );
    expect(familyIds(result)).toContain('chai-stones');
    expect(familyIds(result)).not.toContain('mysterious-text');
    expect(result.best?.marketDiscountPct ?? 0).toBeLessThan(
      VAULT_PRIORITY_DISCOUNT_PCT,
    );
    expect(result.vaultDiscount).toBeUndefined();
  });

  it('still recommends discount when purchasable is stale false after open', () => {
    resetArtifactIds(6200);
    const snapshot = makeSnapshot([
      makeArtifact('light-warping', ArtifactTier.Platinum, {
        equippedPosition: 1,
      }),
      makeArtifact('chai-stones', ArtifactTier.Interstellar, {
        equippedPosition: 2,
      }),
      makeArtifact('pn295', ArtifactTier.Interstellar, {
        equippedPosition: 3,
      }),
      makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar),
    ]);
    const staleOpen = vaultOpenState({
      gameVault: [
        {
          name: 'Vault Game',
          price: 500,
          inStock: true,
          purchasable: false,
        },
      ],
    });
    const result = optimize(
      buildContext(snapshot, defaultArtifactSettings, staleOpen, NOW_MS),
    );
    expect(familyIds(result)).toContain('light-warping');
    expect(result.best?.marketDiscountPct).toBeGreaterThanOrEqual(0.1);
  });
});
