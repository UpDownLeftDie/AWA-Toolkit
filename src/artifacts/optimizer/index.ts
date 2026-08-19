import { battlePassClaimableArp } from '../siteState';
import {
  combinationsWithPinned,
  currentLoadout,
  isSameLoadout,
  pinnedEquippedArtifacts,
  resolveOwnedList,
} from './context';
import { collectNotes } from './notes';
import {
  findBestAllArpCombo,
  findBestCombo,
  findBestMarketDiscountCombo,
  findMonthlyMetaCombo,
  hasAllArpEffect,
  hasInventoryAllArp,
  resolveDeferredAllArp,
  resolveDeferredSteam,
  shouldDeferBattlePassForContext,
  suggestDailySwap,
  suggestUpgrades,
} from './search';
import {
  isAllArpLockWorthBattlePassBoost,
  scoreCombo,
} from './scoring';
import type { OptimizerContext, OptimizerResult, ScoredCombo } from './types';
import { resolveVaultDiscountBest } from './vaultDiscount';

export function optimize(context: OptimizerContext): OptimizerResult {
  const owned = resolveOwnedList(context);

  if (owned.length === 0) {
    return {
      best: undefined,
      current: undefined,
      alternatives: [],
      upgrades: [],
      dailySwap: undefined,
      notes: [
        'No owned artifacts known yet — inventory could not be loaded automatically. Open the optimizer again in a moment, or expand Advanced / manual overrides.',
      ],
      hasAllArpOwned: false,
      hasAllArpEquipped: false,
    };
  }

  const fragments =
    context.settings.manualFragments ?? context.snapshot.fragments;
  const upgrades = suggestUpgrades(owned, fragments);
  const arpBest = findBestCombo(owned, context);
  const equipped = currentLoadout(owned);
  const current =
    equipped.length > 0 ? scoreCombo(equipped, context) : undefined;
  const allArpLoadout = findBestAllArpCombo(owned, context);
  const discountCombo = findBestMarketDiscountCombo(owned, context);
  const guarded = resolveVaultDiscountBest(
    arpBest,
    current,
    discountCombo,
    context,
  );
  const best = guarded.best;
  const monthlyMetaLoadout = findMonthlyMetaCombo(owned, context);

  const alternatives: ScoredCombo[] = [];
  if (owned.length >= 3) {
    const pinned = pinnedEquippedArtifacts(
      owned,
      context.settings,
      context.siteState,
      context.snapshot.slotLocks,
    );
    const scored = combinationsWithPinned(owned, 3, pinned)
      .map((combo) => scoreCombo(combo, context))
      .toSorted((left, right) => right.weeklyArp - left.weeklyArp);
    alternatives.push(...scored.slice(0, 5));
  }
  const marketDiscountLoadout = guarded.marketDiscountLoadout;
  if (
    marketDiscountLoadout &&
    alternatives.every(
      (combo) =>
        !isSameLoadout(combo.artifacts, marketDiscountLoadout.artifacts),
    )
  ) {
    alternatives.push(marketDiscountLoadout);
  }

  const deferredAllArp = resolveDeferredAllArp(owned, context);
  const deferredSteam = resolveDeferredSteam(owned, context, best);
  const shouldDeferBattlePassClaims = shouldDeferBattlePassForContext(context);
  const isDedicatedLockWorthIt = isAllArpLockWorthBattlePassBoost(
    best,
    allArpLoadout,
    battlePassClaimableArp(context.siteState.battlePass),
  );

  const notes = collectNotes(owned, equipped, best, context);

  const result: OptimizerResult = {
    best,
    current,
    alternatives,
    upgrades,
    dailySwap: best ? suggestDailySwap(best, current) : undefined,
    notes,
    hasAllArpOwned: hasInventoryAllArp(owned),
    hasAllArpEquipped: hasAllArpEffect(equipped),
    deferBattlePassClaims: shouldDeferBattlePassClaims,
  };
  if (isDedicatedLockWorthIt) {
    result.worthDedicatedAllArpForBattlePass = true;
  }
  if (context.snapshot.slotLocks) {
    result.slotLocks = context.snapshot.slotLocks;
  }
  if (allArpLoadout) {
    result.allArpLoadout = allArpLoadout;
  }
  if (deferredAllArp) {
    result.deferredAllArp = deferredAllArp;
  }
  if (deferredSteam) {
    result.deferredSteam = deferredSteam;
  }
  if (marketDiscountLoadout) {
    result.marketDiscountLoadout = marketDiscountLoadout;
  }
  if (monthlyMetaLoadout) {
    result.monthlyMetaLoadout = monthlyMetaLoadout;
  }
  if (guarded.vaultDiscount) {
    result.vaultDiscount = guarded.vaultDiscount;
  }
  return result;
}

export type { ActivityLoadoutStats } from './bonuses';
export { activityStatsForArtifacts } from './bonuses';
export {
  buildContext,
  canCompleteInWearWindow,
  canCompleteOutsideWearWindow,
  completableUtcDayStarts,
  isResetInWearWindow,
  msUntilNextSteamQuestWeek,
  UTC_DAILY_END_BUFFER_MS,
} from './context';
export { describeArtifact } from './notes';
export { scoreCombo } from './scoring';
export type {
  BreakdownLine,
  OptimizerContext,
  OptimizerResult,
  ScoredCombo,
  UpgradeSuggestion,
} from './types';
