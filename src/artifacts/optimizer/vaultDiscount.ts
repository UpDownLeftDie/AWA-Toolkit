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
import { comboMarketDiscountPct, projectedRedeemableArp } from './scoring';
import { hasMarketDiscount, VAULT_PRIORITY_DISCOUNT_PCT } from './search';
import type { OptimizerContext, OptimizerResult, ScoredCombo } from './types';

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

interface VaultDiscountGuard {
  best: ScoredCombo | undefined;
  marketDiscountLoadout?: ScoredCombo;
  vaultDiscount?: OptimizerResult['vaultDiscount'];
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
  if (
    discountCombo &&
    !isSameLoadout(best.artifacts, discountCombo.artifacts)
  ) {
    return { best, marketDiscountLoadout: discountCombo, vaultDiscount };
  }
  if (hasMarketDiscount(best)) {
    return { best, vaultDiscount };
  }
  return { best, vaultDiscount };
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

  if (discountCombo) {
    return suggestVaultDiscount(
      discountCombo,
      discountCombo,
      `Equip market-discount before Game Vault opens (${eta}) — a 24h ARP swap would still be locked at open.`,
      cycleId,
    );
  }

  return { best: arpBest };
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
remains. Weaker discounts (Mysterious Text Decipher 2%) never interrupt ARP.
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
  if (opensAt !== undefined && opensAt > now) {
    return resolvePreOpenVaultDiscount(
      arpBest,
      current,
      discountCombo,
      context,
      cycleId ?? context.siteState.gameVaultOpensAt ?? 'upcoming',
      now,
    );
  }

  return { best: arpBest };
}
