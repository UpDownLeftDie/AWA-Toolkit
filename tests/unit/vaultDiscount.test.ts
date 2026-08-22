import { describe, expect, it } from 'vitest';

import { ArtifactTier } from '../../src/artifacts/data';
import { buildContext } from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import { VAULT_PRIORITY_DISCOUNT_PCT } from '../../src/artifacts/optimizer/search';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import {
  isGameVaultDiscountWindow,
  isVaultItemPurchasable,
  isGameVaultClaimedThisCycle,
  scrapeGameVaultFromDocument,
  isGameVaultMonthlyClaimUsedFromDocument,
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

  it('closes the discount window after this user claimed this rotation', () => {
    const claimed = {
      name: 'Ale Abbey',
      price: 1600,
      inStock: true,
      purchasable: true,
      isClaimed: true as const,
    };
    const stillListed = {
      name: 'Cryptmaster',
      price: 2100,
      inStock: true,
      purchasable: true,
    };
    const state = vaultOpenState({
      gameVault: [claimed, stillListed],
      gameVaultClaimedThisCycle: true,
    });
    expect(isVaultItemPurchasable(claimed, state, NOW_MS)).toBe(false);
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

  it('stops vault-discount recs after the monthly Game Vault claim is used', () => {
    resetArtifactIds(6250);
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
    const claimedOpen = vaultOpenState({
      gameVault: [
        {
          name: 'Ale Abbey',
          price: 1600,
          inStock: true,
          purchasable: true,
          isClaimed: true,
        },
        {
          name: 'Cryptmaster',
          price: 2100,
          inStock: true,
          purchasable: true,
        },
      ],
      gameVaultClaimedThisCycle: true,
    });
    const result = optimize(
      buildContext(snapshot, defaultArtifactSettings, claimedOpen, NOW_MS),
    );
    expect(result.vaultDiscount).toBeUndefined();
    expect(result.best?.marketplaceSavingsArp ?? 0).toBe(0);
  });
});

function mockVaultCard(options: {
  price: string;
  name: string;
  text: string;
  inStock?: string;
  disabled?: string;
  omitPrice?: boolean;
}): HTMLElement {
  return {
    dataset: {
      productName: options.name,
      productId: options.name,
      ...(!options.omitPrice && { productPrice: options.price }),
      ...(options.inStock !== undefined && {
        productInStock: options.inStock,
      }),
      ...(options.disabled !== undefined && {
        productDisabled: options.disabled,
      }),
    },
    classList: { contains: () => false },
    querySelector() {
      return { textContent: '' };
    },
    getAttribute() {
      return '';
    },
    textContent: options.text,
  } as unknown as HTMLElement;
}

function mockVaultDocument(cards: HTMLElement[], bodyText: string): Document {
  return {
    body: { textContent: bodyText },
    querySelector() {
      return;
    },
    querySelectorAll: (selector: string) =>
      /data-product-price|marketplace-game-small|marketplace-game-large/.test(
        selector,
      )
        ? cards
        : [],
  } as unknown as Document;
}

describe('Game Vault claimed scrape', () => {
  it('reads Claimed badges and the monthly-claim banner', () => {
    const cards = [
      mockVaultCard({
        price: '2100',
        name: 'Cook, Serve, Delicious! 3?!',
        text: 'Cook, Serve, Delicious! 3?! You have already claimed a game this month! 2100 ARP',
      }),
      mockVaultCard({
        price: '1600',
        name: 'Ale Abbey - Monastery Brewery Tycoon',
        text: 'Ale Abbey - Monastery Brewery Tycoon Claimed 1600 ARP',
      }),
      mockVaultCard({
        price: '2100',
        name: 'Cryptmaster',
        text: 'Cryptmaster You have already claimed a game this month! 2100 ARP',
      }),
    ];
    const document_ = mockVaultDocument(
      cards,
      'You have already claimed a game this month!',
    );
    const vault = scrapeGameVaultFromDocument(document_);
    expect(vault.every((game) => game.isClaimed === true)).toBe(true);
    expect(isGameVaultMonthlyClaimUsedFromDocument(document_)).toBe(true);

    const state = vaultOpenState({
      gameVault: vault,
      gameVaultClaimedThisCycle: true,
    });
    expect(isGameVaultDiscountWindow(state, NOW_MS)).toBe(false);
  });

  it('does not treat a Claim button as already claimed', () => {
    const cards = [
      mockVaultCard({
        price: '1600',
        name: 'Ale Abbey',
        text: 'Ale Abbey Claim for 1600 ARP',
      }),
    ];
    const document_ = mockVaultDocument(cards, 'Ale Abbey Claim for 1600 ARP');
    const vault = scrapeGameVaultFromDocument(document_);
    expect(vault[0]?.isClaimed).toBeUndefined();
    expect(vault[0]?.purchasable).toBe(true);
    expect(isGameVaultMonthlyClaimUsedFromDocument(document_)).toBe(false);
  });

  it('reads live vault cards that only show ARP in the label', () => {
    const cards = [
      mockVaultCard({
        price: '1600',
        name: 'Ale Abbey',
        omitPrice: true,
        text: 'Ale Abbey Claimed 1600 ARP',
      }),
    ];
    const document_ = mockVaultDocument(cards, 'Claimed 1600 ARP');
    const vault = scrapeGameVaultFromDocument(document_);
    expect(vault).toEqual([
      expect.objectContaining({
        name: 'Ale Abbey',
        price: 1600,
        isClaimed: true,
      }),
    ]);
  });
});

describe('isGameVaultClaimedThisCycle', () => {
  it('keeps a prior claim through SSR HTML that still looks purchasable', () => {
    expect(
      isGameVaultClaimedThisCycle(true, {
        isMonthlyClaimUsed: false,
        isScrapedClaimed: false,
        isLiveDocument: false,
        hasClaimAction: false,
      }),
    ).toBe(true);
  });

  it('sets claimed from the monthly banner even when no cards parsed', () => {
    expect(
      isGameVaultClaimedThisCycle(undefined, {
        isMonthlyClaimUsed: true,
        isScrapedClaimed: false,
        isLiveDocument: true,
        hasClaimAction: false,
      }),
    ).toBe(true);
  });

  it('clears the flag on a live page that still has Claim buttons', () => {
    expect(
      isGameVaultClaimedThisCycle(true, {
        isMonthlyClaimUsed: false,
        isScrapedClaimed: false,
        isLiveDocument: true,
        hasClaimAction: true,
      }),
    ).toBe(false);
  });
});
