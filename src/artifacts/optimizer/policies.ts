/**
Artifact-domain policy wrappers.

The planner domain (`src/planner/`) is domain-agnostic and knows nothing about
ScoredCombos or vault state. This module wraps planner policies with the
artifact-specific `loadoutObjective` (which ScoredCombo to pick as `best`) and
provides `resolveActivePolicy` / `selectBestUnderPolicy` for `optimize()` to use.
*/
import type { PriorityPolicy } from '../../planner/types';
import type { ArtifactOptimizerSettings } from '../settings';
import type { SiteState } from '../siteState';
import {
  gameVaultCycleId,
  isGameVaultDiscountWindow,
  gameVaultOpensAtMs,
} from '../siteState/gameVault';
import { hasMarketDiscount, VAULT_PRIORITY_DISCOUNT_PCT } from './search';
import type { OptimizerContext, ScoredCombo } from './types';
import {
  applyMarketplaceDiscountPriority,
  resolveVaultDiscountBest,
  type VaultDiscountGuard,
} from './vaultDiscount';

// ─── Artifact-level policy ───────────────────────────────────────────────────

export interface ArtifactPriorityPolicy extends PriorityPolicy {
  /**
  Score a combo for loadout selection — higher wins.
  Used by selectBestUnderPolicy to pick `best` among the candidates.
  */
  loadoutObjective(combo: ScoredCombo): number;
}

// ─── Individual policy instances ─────────────────────────────────────────────

/**
Default policy: pick the loadout that maximises 24h ARP.
*/
export const lifetimeArpArtifactPolicy: ArtifactPriorityPolicy = {
  id: 'lifetimeArp',
  comparators: [],           // task ordering comes from planner's lifetimeArpPolicy
  loadoutObjective: (c) => c.weeklyArp,
};

/**
Marketplace discount priority: while the user's one-shot flag is pending,
promote a ≥10% market-discount loadout as `best`. Falls back to weeklyArp
when no qualifying combo exists.
*/
export const marketplaceDiscountArtifactPolicy: ArtifactPriorityPolicy = {
  id: 'marketplaceDiscount',
  comparators: [],           // same task comparators as lifetimeArp for now
  loadoutObjective: (c) => {
    if (c.marketDiscountPct >= VAULT_PRIORITY_DISCOUNT_PCT) {
      // Among qualifying: maximise discount first, then weeklyArp as tie-break.
      // Encode as a composite score so the selector's single numeric comparison works.
      // Discount bucket (rounded to 4 dp) wins over any weeklyArp difference.
      const discountBucket = Math.round(c.marketDiscountPct * 10_000);
      return discountBucket * 1_000_000 + c.weeklyArp;
    }
    // No qualifying discount: use weeklyArp — the selector will still prefer
    // the discount combo when one exists, but falls back gracefully.
    return c.weeklyArp;
  },
};

/**
Game Vault discount: while the vault window is active, promote a ≥10%
market-discount loadout so the user can claim vault stock at a discount.
Same loadout objective as marketplace discount.
*/
export const gameVaultDiscountArtifactPolicy: ArtifactPriorityPolicy = {
  id: 'gameVaultDiscount',
  comparators: [],           // same task comparators as lifetimeArp for now
  loadoutObjective: (c) => {
    if (c.marketDiscountPct >= VAULT_PRIORITY_DISCOUNT_PCT) {
      const discountBucket = Math.round(c.marketDiscountPct * 10_000);
      return discountBucket * 1_000_000 + c.weeklyArp;
    }
    return c.weeklyArp;
  },
};

// ─── Policy resolution ───────────────────────────────────────────────────────

/**
Select the active policy given the current settings and site state.

Priority order (matches pre-Phase-5 override order):
1. marketplaceDiscountPriorityPending → marketplaceDiscount
2. Vault discount window would interrupt ARP → gameVaultDiscount
3. Otherwise → lifetimeArp
*/
export function resolveActivePolicy(
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  nowMs: number,
): ArtifactPriorityPolicy {
  if (settings.marketplaceDiscountPriorityPending) {
    return marketplaceDiscountArtifactPolicy;
  }

  // Mirror the guard condition from resolveVaultDiscountBest: only escalate
  // when a qualifying vault window exists and would interrupt ARP recs.
  const cycleId = gameVaultCycleId(siteState);
  if (cycleId && settings.vaultDiscountDismissedCycle !== cycleId) {
    const isOpen = isGameVaultDiscountWindow(siteState, nowMs);
    const opensAt = gameVaultOpensAtMs(siteState);
    const isUpcoming = !isOpen && opensAt !== undefined && opensAt > nowMs;
    if (isOpen || isUpcoming) {
      return gameVaultDiscountArtifactPolicy;
    }
  }

  return lifetimeArpArtifactPolicy;
}

// ─── Best-combo selector ─────────────────────────────────────────────────────

function comboLoadoutKey(combo: ScoredCombo): string {
  return combo.artifacts
    .map((a) => a.instanceId)
    .toSorted((a, b) => a - b)
    .join(',');
}

function pickBestCandidate(
  policy: ArtifactPriorityPolicy,
  ...combos: (ScoredCombo | undefined)[]
): ScoredCombo | undefined {
  const seen = new Set<string>();
  let best: ScoredCombo | undefined;
  for (const combo of combos) {
    if (!combo) {
      continue;
    }
    const key = comboLoadoutKey(combo);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (best === undefined || policy.loadoutObjective(combo) > policy.loadoutObjective(best)) {
      best = combo;
    }
  }
  return best;
}

/**
Build the candidate list `[arpBest, discountCombo, current]` (defined values,
unique by loadout identity), score each by `policy.loadoutObjective`, and
return the winner as `best`. Vault/marketplace metadata (vaultDiscount notes,
marketplaceDiscountPriority, marketDiscountLoadout, alreadyEquipped, slotsLocked)
is still produced by the existing vault helpers — their `best` field is replaced
by the candidate-selected winner so notes remain accurate.

For lifetimeArp: `best = arpBest` (findBestCombo already maximised weeklyArp);
  vault helpers are not invoked; marketDiscountLoadout is attached for the
  alternatives panel / soft notes.
For gameVaultDiscount / marketplaceDiscount: candidates are scored by
  `loadoutObjective` (which grants a large bonus to qualifying discount combos),
  so the selection matches the previous resolveVaultDiscountBest /
  applyMarketplaceDiscountPriority behaviour in common cases while making the
  objective explicit and testable.
*/
export function selectBestUnderPolicy(
  policy: ArtifactPriorityPolicy,
  arpBest: ScoredCombo | undefined,
  current: ScoredCombo | undefined,
  discountCombo: ScoredCombo | undefined,
  context: OptimizerContext,
  now: number,
): VaultDiscountGuard {
  if (policy.id === 'lifetimeArp') {
    // lifetimeArp: arpBest is already the weeklyArp maximum — no re-ranking needed.
    // Still attach marketDiscountLoadout for the alternatives panel / soft notes.
    const marketDiscountLoadout =
      hasMarketDiscount(discountCombo) ? discountCombo : undefined;
    return marketDiscountLoadout
      ? { best: arpBest, marketDiscountLoadout }
      : { best: arpBest };
  }

  // Discount policies: build candidate list (unique by loadout), pick winner by
  // loadoutObjective, then attach vault/marketplace metadata from existing helpers.
  const selectedBest = pickBestCandidate(policy, arpBest, discountCombo, current);

  if (policy.id === 'gameVaultDiscount') {
    // The vault helper implements the full context-aware selection logic for this
    // policy (timing, slot locks, affordable games etc.). Its `best` already
    // reflects the loadoutObjective for the gameVaultDiscount case. Run it and
    // let `selectedBest` act as a consistent override only when both agree that
    // the discount combo is the right pick — i.e. when the vault helper itself
    // already chose something other than arpBest (discount or current), use
    // selectedBest; otherwise trust the vault helper's context-aware decision.
    const vaultGuarded = resolveVaultDiscountBest(arpBest, current, discountCombo, context, now);
    const isVaultChoseDiscount =
      vaultGuarded.best !== undefined &&
      arpBest !== undefined &&
      vaultGuarded.best !== arpBest;
    const resolvedBest = isVaultChoseDiscount ? selectedBest : vaultGuarded.best;
    const withSelected: VaultDiscountGuard = { ...vaultGuarded, best: resolvedBest };
    // Attach marketDiscountLoadout when vault logic did not.
    if (discountCombo && !withSelected.marketDiscountLoadout && hasMarketDiscount(discountCombo)) {
      return { ...withSelected, marketDiscountLoadout: discountCombo };
    }
    return withSelected;
  }

  // marketplaceDiscount: vault first (attaches notes/marketDiscountLoadout), then
  // marketplace metadata layer (attaches priority note, alreadyEquipped, slotsLocked).
  // The candidate-selection winner (loadoutObjective) drives `best`.
  const vaultGuarded = resolveVaultDiscountBest(arpBest, current, discountCombo, context, now);
  const withMarketplace = applyMarketplaceDiscountPriority(
    vaultGuarded,
    arpBest,
    current,
    discountCombo,
    context,
    now,
  );
  // Replace best with candidate-selection winner (loadoutObjective decides).
  return { ...withMarketplace, best: selectedBest };
}
