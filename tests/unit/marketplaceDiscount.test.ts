import { describe, expect, it } from 'vitest';

import { ArtifactTier } from '../../src/artifacts/data';
import { buildContext } from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import { appendMarketplaceFragmentNotes } from '../../src/artifacts/optimizer/notes';
import { lockWindowArpLossLines } from '../../src/artifacts/optimizer/scoring';
import { artifactsHaveMarketDiscount } from '../../src/artifacts/optimizer/search';
import { artifactsAfterImmediateEquip } from '../../src/artifacts/optimizer/swapPlan';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import type { ScoredCombo } from '../../src/artifacts/optimizer/types';
import {
  parseMarketplaceTimerEndDate,
  primaryExpiringFragmentOffer,
  scrapeMarketplaceFragmentsFromDocument,
} from '../../src/artifacts/siteState/marketplaceFragments';
import type { SiteState } from '../../src/artifacts/siteState/types';
import {
  makeArtifact,
  makeSnapshot,
  resetArtifactIds,
} from '../fixtures/artifactFactory';
import { isoAt, utcAt } from '../fixtures/scenarios/shared';

const NOW_MS = utcAt(2026, 7, 21, 16, 0);

function baseState(overrides: Partial<SiteState> = {}): SiteState {
  return {
    capsScrapedAt: isoAt(NOW_MS),
    caps: {
      timeOnSite: 'available',
      watchTwitch: 'available',
      dailyCalendar: 'available',
      dailyQuests: 'available',
      discordPoll: 'available',
      steamCommunityEvent: 'unknown',
      steamQuests: 'capped',
    },
    gameVault: [],
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

function mockFragmentCard(options: {
  id: string;
  name: string;
  price: string;
  text: string;
  inStock?: string;
  disabled?: string;
  endsAt?: string;
}): HTMLElement {
  const timer = options.endsAt
    ? {
        dataset: { timerEndDate: options.endsAt },
      }
    : null;
  return {
    dataset: {
      productName: options.name,
      productId: options.id,
      productPrice: options.price,
      ...(options.inStock !== undefined && {
        productInStock: options.inStock,
      }),
      ...(options.disabled !== undefined && {
        productDisabled: options.disabled,
      }),
    },
    classList: { contains: () => false },
    querySelector(selector: string) {
      if (
        timer &&
        /marketplace-product-timer|data-timer-end-date/.test(selector)
      ) {
        return timer;
      }
      if (/marketplace-product-timer|data-timer-end-date/.test(selector)) {
        return null;
      }
      return { textContent: '' };
    },
    getAttribute() {
      return '';
    },
    textContent: options.text,
  } as unknown as HTMLElement;
}

function mockFragmentDocument(cards: HTMLElement[]): Document {
  return {
    querySelectorAll: (selector: string) =>
      selector.includes('marketplace-product') ? cards : [],
  } as unknown as Document;
}

describe('parseMarketplaceTimerEndDate', () => {
  it('parses AWA timer strings as UTC ISO', () => {
    expect(parseMarketplaceTimerEndDate('2026-12-01 00:00:00')).toBe(
      '2026-12-01T00:00:00.000Z',
    );
  });
});

describe('scrapeMarketplaceFragmentsFromDocument', () => {
  it('reads list-price cards and timer end dates', () => {
    const document_ = mockFragmentDocument([
      mockFragmentCard({
        id: '405',
        name: 'Mysterious Text',
        price: '1',
        text: 'Mysterious Text 1 ARP',
      }),
      mockFragmentCard({
        id: '632',
        name: 'Bali Arches',
        price: '1000',
        text: 'Bali Arches 1000 ARP Ends in:',
        endsAt: '2026-12-01 00:00:00',
      }),
    ]);
    const offers = scrapeMarketplaceFragmentsFromDocument(document_);
    expect(offers).toHaveLength(2);
    expect(offers[0]?.name).toBe('Mysterious Text');
    expect(offers[0]?.endsAt).toBeUndefined();
    expect(offers[1]?.price).toBe(1000);
    expect(offers[1]?.endsAt).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('soft path fragment notes', () => {
  it('does not replace ARP best when timed fragment stock exists', () => {
    resetArtifactIds(7000);
    const snapshot = makeSnapshot([
      makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar, {
        equippedPosition: 1,
      }),
      makeArtifact('pn295', ArtifactTier.Interstellar, {
        equippedPosition: 2,
      }),
      makeArtifact('chai-stones', ArtifactTier.Interstellar, {
        equippedPosition: 3,
      }),
      makeArtifact('light-warping', ArtifactTier.Platinum),
    ]);
    const state = baseState({
      marketplaceFragments: [
        {
          name: 'Bali Arches',
          price: 1000,
          inStock: true,
          endsAt: isoAt(NOW_MS + 2 * 24 * 60 * 60 * 1000),
        },
      ],
      gameVaultOpensAt: isoAt(NOW_MS + 5 * 24 * 60 * 60 * 1000),
    });
    const result = optimize(
      buildContext(snapshot, defaultArtifactSettings, state, NOW_MS),
    );
    expect(result.marketplaceDiscountPriority).toBeUndefined();
    expect(result.best?.marketDiscountPct ?? 0).toBeLessThan(0.1);
    expect(result.marketDiscountLoadout?.marketDiscountPct).toBeGreaterThanOrEqual(
      0.1,
    );
    expect(result.notes.some((note) => /Marketplace:.*Bali Arches/i.test(note))).toBe(
      true,
    );
  });

  it('warns when listing ends before Game Vault opens', () => {
    const notes: string[] = [];
    const state = baseState({
      marketplaceFragments: [
        {
          name: '10 Fragments',
          price: 150,
          inStock: true,
          endsAt: isoAt(NOW_MS + 24 * 60 * 60 * 1000),
        },
      ],
      gameVaultOpensAt: isoAt(NOW_MS + 5 * 24 * 60 * 60 * 1000),
    });
    const discount = {
      artifacts: [],
      weeklyArp: 100,
      marketplaceSavingsArp: 0,
      totalScore: 100,
      allArpPct: 0,
      steamQuestsFlat: 0,
      watchTwitchFlat: 0,
      dailyCalendarFlat: 0,
      discordPollFlat: 0,
      marketDiscountPct: 0.15,
      activeSetNames: ['The Stanley Excavation'],
      breakdown: {},
    };
    appendMarketplaceFragmentNotes(
      notes,
      [],
      [],
      discount,
      discount,
      buildContext(
        makeSnapshot([]),
        defaultArtifactSettings,
        state,
        NOW_MS,
      ),
    );
    expect(notes[0]).toMatch(/before Game Vault opens/i);
  });

  it('does not recommend buying an artifact the user already owns', () => {
    resetArtifactIds(7100);
    const snapshot = makeSnapshot([
      makeArtifact('bali-arches', ArtifactTier.Interstellar, {
        equippedPosition: 1,
      }),
      makeArtifact('pn295', ArtifactTier.Interstellar, {
        equippedPosition: 2,
      }),
      makeArtifact('chai-stones', ArtifactTier.Interstellar, {
        equippedPosition: 3,
      }),
    ]);
    const state = baseState({
      marketplaceFragments: [
        {
          name: "Ba'li Arches",
          price: 1000,
          inStock: true,
          endsAt: isoAt(NOW_MS + 7 * 24 * 60 * 60 * 1000),
        },
        {
          name: '10 Fragments',
          price: 150,
          inStock: true,
          endsAt: isoAt(NOW_MS + 2 * 24 * 60 * 60 * 1000),
        },
      ],
    });
    const result = optimize(
      buildContext(snapshot, defaultArtifactSettings, state, NOW_MS),
    );
    expect(result.notes.some((note) => /Ba'?li Arches/i.test(note))).toBe(
      false,
    );
    expect(result.notes.some((note) => /10 Fragments/i.test(note))).toBe(true);
  });

  it('picks the soonest affordable expiring offer', () => {
    const state = baseState({
      marketplaceFragments: [
        {
          name: 'Later',
          price: 500,
          inStock: true,
          endsAt: isoAt(NOW_MS + 5 * 24 * 60 * 60 * 1000),
        },
        {
          name: 'Soon',
          price: 200,
          inStock: true,
          endsAt: isoAt(NOW_MS + 24 * 60 * 60 * 1000),
        },
      ],
    });
    expect(primaryExpiringFragmentOffer(state, 0.15, 2000, NOW_MS)?.name).toBe(
      'Soon',
    );
  });
});

describe('lockWindowArpLossLines', () => {
  it('reports per-activity deltas sorted by magnitude', () => {
    const arpBest = {
      weeklyArp: 89,
      breakdown: {
        watchTwitch: { total: 45, base: 30, categoryBonus: 15, allArpBonus: 0 },
        dailyCalendar: { total: 12, base: 6, categoryBonus: 6, allArpBonus: 0 },
        steamQuests: { total: 20, base: 15, categoryBonus: 5, allArpBonus: 0 },
      },
    } as unknown as ScoredCombo;
    const discount = {
      weeklyArp: 53,
      breakdown: {
        watchTwitch: { total: 15, base: 15, categoryBonus: 0, allArpBonus: 0 },
        dailyCalendar: { total: 6, base: 6, categoryBonus: 0, allArpBonus: 0 },
        steamQuests: { total: 25, base: 15, categoryBonus: 10, allArpBonus: 0 },
      },
    } as unknown as ScoredCombo;
    const lines = lockWindowArpLossLines(arpBest, discount);
    expect(lines[0]).toMatchObject({
      key: 'watchTwitch',
      from: 45,
      to: 15,
      delta: 30,
    });
    expect(lines.find((line) => line.key === 'steamQuests')?.delta).toBe(-5);
  });
});

describe('one-shot marketplace discount prioritization', () => {
  it('promotes ≥10% discount as best while pending', () => {
    resetArtifactIds(7100);
    const snapshot = makeSnapshot([
      makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar, {
        equippedPosition: 1,
        slotLocked: false,
      }),
      makeArtifact('pn295', ArtifactTier.Interstellar, {
        equippedPosition: 2,
        slotLocked: false,
      }),
      makeArtifact('chai-stones', ArtifactTier.Interstellar, {
        equippedPosition: 3,
        slotLocked: false,
      }),
      makeArtifact('light-warping', ArtifactTier.Platinum),
    ]);
    const settings = {
      ...defaultArtifactSettings,
      marketplaceDiscountPriorityPending: true,
    };
    const result = optimize(
      buildContext(snapshot, settings, baseState(), NOW_MS),
    );
    expect(familyIds(result)).toContain('light-warping');
    expect(result.best?.marketDiscountPct).toBeGreaterThanOrEqual(0.1);
    expect(result.marketplaceDiscountPriority?.pending).toBe(true);
    expect(result.marketplaceDiscountPriority?.note).toMatch(/Equip/i);
    if ((result.marketplaceDiscountPriority?.arpDelta ?? 0) > 0) {
      expect(
        result.marketplaceDiscountPriority?.arpLossLines?.length,
      ).toBeGreaterThan(0);
    }
  });

  it('marks alreadyEquipped when current loadout already has ≥10% discount', () => {
    resetArtifactIds(7200);
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
    ]);
    const settings = {
      ...defaultArtifactSettings,
      marketplaceDiscountPriorityPending: true,
    };
    const result = optimize(
      buildContext(snapshot, settings, baseState(), NOW_MS),
    );
    expect(result.marketplaceDiscountPriority?.alreadyEquipped).toBe(true);
    expect(result.best?.marketDiscountPct).toBeGreaterThanOrEqual(0.1);
  });

  it('does not treat a single Stanley piece as qualifying discount yet', () => {
    resetArtifactIds(7250);
    const chai = makeArtifact('chai-stones', ArtifactTier.Interstellar);
    const robes = makeArtifact('herkow-fertility-robes', ArtifactTier.Gold);
    const battery = makeArtifact(
      'pn295-unstable-battery',
      ArtifactTier.Interstellar,
    );
    expect(artifactsHaveMarketDiscount([chai])).toBe(false);
    expect(artifactsHaveMarketDiscount([chai, robes, battery])).toBe(true);
  });

  it('keeps prioritization armed after only the unlocked discount piece equips', () => {
    resetArtifactIds(7260);
    const current = {
      artifacts: [
        makeArtifact('pn295', ArtifactTier.Interstellar, {
          equippedPosition: 1,
        }),
        makeArtifact('bali-arches', ArtifactTier.Platinum, {
          equippedPosition: 2,
        }),
        makeArtifact('zorathian-cosmotheque', ArtifactTier.Gold, {
          equippedPosition: 3,
        }),
      ],
    };
    const target = {
      artifacts: [
        makeArtifact('chai-stones', ArtifactTier.Interstellar, {
          instanceId: 9001,
        }),
        makeArtifact('herkow-fertility-robes', ArtifactTier.Gold, {
          instanceId: 9002,
        }),
        makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar, {
          instanceId: 9003,
        }),
      ],
    };
    const worn = artifactsAfterImmediateEquip(current, target, {
      now: [
        {
          artifactId: 9001,
          position: 1,
          displayName: 'Chai Stones',
        },
      ],
      later: [
        {
          artifactId: 9002,
          position: 2,
          displayName: 'Robes',
        },
        {
          artifactId: 9003,
          position: 3,
          displayName: 'Battery',
        },
      ],
      laterNames: ['Robes', 'Battery'],
      lockedSlots: [2, 3],
      waitMs: 60_000,
    });
    // One Stanley piece is not ≥10% — prioritization must stay on.
    expect(artifactsHaveMarketDiscount(worn)).toBe(false);
    expect(artifactsHaveMarketDiscount(target.artifacts)).toBe(true);
  });

  it('keeps pending and flags slotsLocked when nothing can equip yet', () => {
    resetArtifactIds(7300);
    const snapshot = makeSnapshot(
      [
        makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar, {
          equippedPosition: 1,
          slotLocked: true,
        }),
        makeArtifact('pn295', ArtifactTier.Interstellar, {
          equippedPosition: 2,
          slotLocked: true,
        }),
        makeArtifact('chai-stones', ArtifactTier.Interstellar, {
          equippedPosition: 3,
          slotLocked: true,
        }),
        makeArtifact('light-warping', ArtifactTier.Platinum),
      ],
      { slotLocks: { 1: true, 2: true, 3: true } },
    );
    const settings = {
      ...defaultArtifactSettings,
      marketplaceDiscountPriorityPending: true,
      slotCooldowns: [
        {
          position: 1 as const,
          changedAt: isoAt(NOW_MS - 60_000),
        },
        {
          position: 2 as const,
          changedAt: isoAt(NOW_MS - 60_000),
        },
        {
          position: 3 as const,
          changedAt: isoAt(NOW_MS - 60_000),
        },
      ],
    };
    const result = optimize(
      buildContext(snapshot, settings, baseState(), NOW_MS),
    );
    expect(result.marketplaceDiscountPriority?.pending).toBe(true);
    expect(result.marketplaceDiscountPriority?.slotsLocked).toBe(true);
    expect(familyIds(result)).toContain('light-warping');
  });
});
