import {
  COOLDOWN_MS,
  showroomCooldownRemainingMs,
  type ArtifactSlotPosition,
} from '../settings';
import {
  canAffordAnyVaultOffer,
  formatCommunityEta,
  gameVaultCycleId,
  gameVaultOpensAtMs,
  hasPostedListPriceVaultGames,
  isGameVaultDiscountWindow,
  willMissDiscountEquipBeforeOpen,
} from '../siteState';
import { isSameLoadout } from './context';
import {
  comboMarketDiscountPct,
  lockWindowArpLossLines,
  projectedRedeemableArp,
} from './scoring';
import { hasMarketDiscount, VAULT_PRIORITY_DISCOUNT_PCT } from './search';
import type {
  ArpLossLine,
  OptimizerContext,
  OptimizerResult,
  ScoredCombo,
} from './types';

export function earliestSlotUnlockMs(
  context: OptimizerContext,
  now = Date.now(),
): number {
  const slotLocks = context.snapshot.slotLocks;
  const remaining = ([1, 2, 3] as ArtifactSlotPosition[]).map((position) => {
    const equipped = context.snapshot.artifacts.find(
      (artifact) => artifact.equippedPosition === position,
    );
    return showroomCooldownRemainingMs(context.settings, position, {
      now,
      ...(slotLocks && { slotLocks }),
      ...(typeof equipped?.slotLocked === 'boolean' && {
        equippedSlotLocked: equipped.slotLocked,
      }),
    });
  });
  return now + Math.min(...remaining);
}

export interface VaultDiscountGuard {
  best: ScoredCombo | undefined;
  marketDiscountLoadout?: ScoredCombo;
  vaultDiscount?: OptimizerResult['vaultDiscount'];
  marketplaceDiscountPriority?: OptimizerResult['marketplaceDiscountPriority'];
}

function dismissedVaultGuard(
  arpBest: ScoredCombo | undefined,
  cycleId: string,
): VaultDiscountGuard {
  return {
    best: arpBest,
    vaultDiscount: { cycleId, dismissed: true },
  };
}

export function suggestVaultDiscount(
  best: ScoredCombo,
  discountCombo: ScoredCombo | undefined,
  note: string,
  cycleId: string,
): VaultDiscountGuard {
  const vaultDiscount = { cycleId, note, dismissed: false };
  return discountCombo &&
    !isSameLoadout(best.artifacts, discountCombo.artifacts) ? { best, marketDiscountLoadout: discountCombo, vaultDiscount } : { best, vaultDiscount };
}

export function resolvePreOpenVaultDiscount(
  arpBest: ScoredCombo,
  current: ScoredCombo | undefined,
  discountCombo: ScoredCombo | undefined,
  context: OptimizerContext,
  cycleId: string,
  now: number,
): VaultDiscountGuard {
  const opensAt = gameVaultOpensAtMs(context.siteState);
  if (opensAt === undefined) {
    return { best: arpBest };
  }
  const eta = formatCommunityEta(Math.max(0, opensAt - now));
  const swapAt = earliestSlotUnlockMs(context, now);
  const isAlreadyOnBest =
    current !== undefined &&
    isSameLoadout(arpBest.artifacts, current.artifacts);

  if (isAlreadyOnBest) {
    if (!willMissDiscountEquipBeforeOpen(swapAt, context.siteState, now)) {
      return { best: arpBest };
    }
    return {
      best: arpBest,
      vaultDiscount: {
        cycleId,
        dismissed: false,
        note: `Slots locked past Game Vault open (${eta}) — market-discount may not be equippable in time.`,
      },
    };
  }

  if (
    !willMissDiscountEquipBeforeOpen(
      swapAt + COOLDOWN_MS,
      context.siteState,
      now,
    )
  ) {
    return { best: arpBest };
  }

  if (current && hasMarketDiscount(current)) {
    return suggestVaultDiscount(
      current,
      discountCombo,
      `Keep market-discount equipped until Game Vault opens (${eta}) — swapping now would lock slots past open.`,
      cycleId,
    );
  }

  return discountCombo ? suggestVaultDiscount(
      discountCombo,
      discountCombo,
      `Equip market-discount before Game Vault opens (${eta}) — a 24h ARP swap would still be locked at open.`,
      cycleId,
    ) : { best: arpBest };
}

export function resolveOpenVaultDiscount(
  arpBest: ScoredCombo,
  current: ScoredCombo | undefined,
  discountCombo: ScoredCombo | undefined,
  context: OptimizerContext,
  cycleId: string,
  now: number,
): VaultDiscountGuard {
  if (current && hasMarketDiscount(current)) {
    return suggestVaultDiscount(
      current,
      discountCombo,
      'Keep market-discount equipped — Game Vault stock can run out, and a 24h swap would miss the discount.',
      cycleId,
    );
  }

  if (!discountCombo) {
    return { best: arpBest };
  }

  const canEquipNow = earliestSlotUnlockMs(context, now) <= now;
  return suggestVaultDiscount(
    discountCombo,
    discountCombo,
    canEquipNow
      ? 'Equip market-discount before claiming Game Vault (eligible stock can run out). Logout/relogin after.'
      : 'Slots locked — Game Vault stock may run out before you can equip market-discount.',
    cycleId,
  );
}

/**
Pre-open: only interrupt ARP recs when a 24h lock would still be running at
vault open (discount gear would not be equippable in time). Skip like dismiss
when current ARP + remaining 24h earnings still cannot cover any posted
eligible game even with discount. After open: the recommended loadout is a
vault-priority market-discount set (≥10%, e.g. Light Warping Platinum / Stanley)
until they buy — do not keep a 24h ARP combo as `best` while eligible stock
remains. After they claim this rotation, stop interrupting ARP. Weaker
discounts (Mysterious Text Decipher 2%) never interrupt ARP.
Auctions never count. Dismissable per rotation.
*/
export function resolveVaultDiscountBest(
  arpBest: ScoredCombo | undefined,
  current: ScoredCombo | undefined,
  discountCombo: ScoredCombo | undefined,
  context: OptimizerContext,
  now = Date.now(),
): VaultDiscountGuard {
  const cycleId = gameVaultCycleId(context.siteState);
  if (cycleId && context.settings.vaultDiscountDismissedCycle === cycleId) {
    return dismissedVaultGuard(arpBest, cycleId);
  }
  if (!arpBest || hasMarketDiscount(arpBest)) {
    return { best: arpBest };
  }

  const discountPct = comboMarketDiscountPct(discountCombo);
  // Tiny discounts (e.g. Decipher 2%) must not displace ARP / Stanley progress.
  if (discountPct < VAULT_PRIORITY_DISCOUNT_PCT) {
    return { best: arpBest };
  }
  const projectedArp = projectedRedeemableArp(
    context,
    arpBest,
    current,
    discountCombo,
  );
  if (
    hasPostedListPriceVaultGames(context.siteState) &&
    !canAffordAnyVaultOffer(context.siteState, discountPct, projectedArp)
  ) {
    return { best: arpBest };
  }

  if (isGameVaultDiscountWindow(context.siteState, now)) {
    return resolveOpenVaultDiscount(
      arpBest,
      current,
      discountCombo,
      context,
      cycleId ?? 'open',
      now,
    );
  }

  const opensAt = gameVaultOpensAtMs(context.siteState);
  return opensAt !== undefined && opensAt > now ? resolvePreOpenVaultDiscount(
      arpBest,
      current,
      discountCombo,
      context,
      cycleId ?? context.siteState.gameVaultOpensAt ?? 'upcoming',
      now,
    ) : { best: arpBest };
}

/**
One-shot marketplace discount prioritization: while the user switch is pending,
promote a ≥10% market-discount loadout as `best` (with ARP-loss warning) until
equip succeeds and the UI clears the flag. Soft fragment notes stay in
`collectNotes` and never force `best` on their own.
*/
export function applyMarketplaceDiscountPriority(
  guarded: VaultDiscountGuard,
  arpBest: ScoredCombo | undefined,
  current: ScoredCombo | undefined,
  discountCombo: ScoredCombo | undefined,
  context: OptimizerContext,
  now = Date.now(),
): VaultDiscountGuard {
  const qualifyingDiscount = hasMarketDiscount(discountCombo)
    ? discountCombo
    : undefined;
  const marketDiscountLoadout =
    qualifyingDiscount ?? guarded.marketDiscountLoadout;
  const withLoadout: VaultDiscountGuard = marketDiscountLoadout
    ? { ...guarded, marketDiscountLoadout }
    : { ...guarded };

  if (!context.settings.marketplaceDiscountPriorityPending) {
    return withLoadout;
  }

  if (!qualifyingDiscount) {
    return {
      ...withLoadout,
      marketplaceDiscountPriority: {
        pending: true,
        note: 'Marketplace discount prioritization needs a ≥10% discount set (e.g. Stanley Excavation or Light Warping Platinum).',
        arpDelta: 0,
      },
    };
  }

  const arpDelta = Math.max(
    0,
    (arpBest?.weeklyArp ?? 0) - qualifyingDiscount.weeklyArp,
  );
  const arpLossLines: ArpLossLine[] =
    arpBest && arpDelta > 0
      ? lockWindowArpLossLines(arpBest, qualifyingDiscount)
      : [];
  const discountPct = Math.round(
    comboMarketDiscountPct(qualifyingDiscount) * 100,
  );
  const deltaNote =
    arpDelta > 0
      ? ` About ${String(arpDelta)} ARP less than your ARP-optimal set over the next 24h lock — see activity breakdown. Finish non-delayable dailies first when marked, and delay Steam Quests until after the swap when possible.`
      : ' Lock-window ARP is similar to your best set.';

  if (current && hasMarketDiscount(current)) {
    const wornPct = Math.round(comboMarketDiscountPct(current) * 100);
    return {
      ...withLoadout,
      best: current,
      marketDiscountLoadout: qualifyingDiscount,
      marketplaceDiscountPriority: {
        pending: true,
        note: `${String(wornPct)}% market-discount already equipped — you have ~24h to buy. Prioritization will clear.`,
        arpDelta,
        ...(arpLossLines.length > 0 && { arpLossLines }),
        alreadyEquipped: true,
      },
    };
  }

  const unlockAt = earliestSlotUnlockMs(context, now);
  const canEquipNow = unlockAt <= now;
  if (!canEquipNow) {
    const unlockEta = formatCommunityEta(unlockAt - now);
    return {
      ...withLoadout,
      best: qualifyingDiscount,
      marketDiscountLoadout: qualifyingDiscount,
      marketplaceDiscountPriority: {
        pending: true,
        note: `Marketplace discount prioritization armed — equip ${String(discountPct)}% discount when slots unlock (${unlockEta}).${deltaNote}`,
        arpDelta,
        ...(arpLossLines.length > 0 && { arpLossLines }),
        slotsLocked: true,
      },
    };
  }

  return {
    ...withLoadout,
    best: qualifyingDiscount,
    marketDiscountLoadout: qualifyingDiscount,
    marketplaceDiscountPriority: {
      pending: true,
      note: `Equip ${String(discountPct)}% market-discount now to shop — switch clears after equip; then you have 24h to buy.${deltaNote}`,
      arpDelta,
      ...(arpLossLines.length > 0 && { arpLossLines }),
    },
  };
}
