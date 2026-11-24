import type { OwnedArtifact } from '../scraper';
import { COOLDOWN_MS } from '../settings';
import {
  battlePassClaimableArp,
  breakDownCommunityEventPending,
  canAffordVaultPrice,
  canEarnCommunityEventArp,
  estimateCommunityUnlockAt,
  gameVaultCatalogPrice,
  isCommunityGateMet,
  isGameVaultCurrentlyOpen,
  isPersonalHoursMet,
  vaultPayArp,
  type SiteState,
} from '../siteState';
import {
  collectBonuses,
  setBreakdownParts,
  type BonusBuckets,
} from './bonuses';
import {
  activeSets,
  comboEquipWaitMs,
  currentLoadout,
  resolveNow,
  resolveOwnedList,
} from './context';
import { hasAllArpEffect, shouldDeferBattlePassForContext } from './allArp';
import { ACTIVITIES } from '../activities';
import type { Opportunity } from '../activities';
import type {
  ArpLossLine,
  BreakdownLine,
  OptimizerContext,
  RawBreakdownParts,
  ScoredCombo,
} from './types';

/**
Base ARP per ready Battle Pass ARP Boost (pre All-ARP% multiplier).
*/
export const BATTLE_PASS_BOOST_ARP = 40;

/**
A dedicated 24h All-ARP% lock is only worth it when the extra multiplier on
ready BP boosts beats the lock-window ARP lost vs the recommended set.
*/
export function isAllArpLockWorthBattlePassBoost(
  best: ScoredCombo | undefined,
  allArp: ScoredCombo | undefined,
  readyBoosts: number,
): boolean {
  if (!best || !allArp || allArp.allArpPct <= 0 || readyBoosts <= 0) {
    return false;
  }
  const extraOnBoost =
    readyBoosts * BATTLE_PASS_BOOST_ARP * (allArp.allArpPct - best.allArpPct);
  if (extraOnBoost <= 0) {
    return false;
  }
  const lockCost = best.weeklyArp - allArp.weeklyArp;
  return extraOnBoost > lockCost;
}

/**
Community Event ARP that this 24h lock will still be wearing when it grants.

Personal-hours-not-met: player-controlled — score it (equip All-ARP% first).
Waiting-on-community: per milestone, only if that gate's ASCE ETA lands
while this loadout is worn (`waitMs` until equip, then 24h). 75k in ~16h
with a 12h lock is a miss; 75k after a 16h wait still counts. The award
fires on whatever is equipped; All-ARP% is the only boost (Megumin FAQ).
Watch Twitch repeats daily — it must not beat this one-shot. Unknown ETA
stays unscored. Both-gates-met is scrape lag — ignore.

Delegates to the steamCommunityEvent activity module.
*/
export function communityEventArpInSwapWindow(
  siteState: SiteState,
  waitMs = 0,
): number {
  const event = siteState.communityEvent;
  if (!event?.isLive || !canEarnCommunityEventArp(event)) {
    return 0;
  }
  const pending = breakDownCommunityEventPending(event);
  let arp = pending.waitingPersonalArp;
  for (const milestone of event.milestones) {
    if (
      milestone.isAwarded ||
      milestone.arpReward <= 0 ||
      !isPersonalHoursMet(milestone, event.personalHours) ||
      isCommunityGateMet(milestone, event.communityHours)
    ) {
      continue;
    }
    const target = milestone.communityHoursRequired;
    if (target === undefined) {
      continue;
    }
    const eta = estimateCommunityUnlockAt(event, target);
    if (
      eta !== undefined &&
      eta.etaMs >= waitMs &&
      eta.etaMs <= waitMs + COOLDOWN_MS
    ) {
      arp += milestone.arpReward;
    }
  }
  return arp;
}

/**
Accumulate opportunities from a single activity into the breakdown map.
Returns the flat (pre-multiplier) sum contributed.
*/
function scoreActivityOpportunities(
  breakdown: Record<string, RawBreakdownParts>,
  opps: Opportunity[],
): number {
  const byKey = new Map<string, { base: number; categoryBonus: number }>();
  for (const opp of opps) {
    const existing = byKey.get(opp.breakdownKey);
    if (existing) {
      existing.base += opp.baseArp;
      existing.categoryBonus += opp.categoryBonus ?? 0;
    } else {
      byKey.set(opp.breakdownKey, {
        base: opp.baseArp,
        categoryBonus: opp.categoryBonus ?? 0,
      });
    }
  }
  let flatSum = 0;
  for (const [key, parts] of byKey) {
    flatSum += setBreakdownParts(breakdown, key, parts.base, parts.categoryBonus);
  }
  return flatSum;
}

function scoreWindowActivities(
  bonuses: BonusBuckets,
  context: OptimizerContext,
  waitMs: number,
): { flatSum: number; breakdown: Record<string, RawBreakdownParts> } {
  const { settings, siteState } = context;
  const now = resolveNow(context);
  const acts = settings.activities;
  const breakdown: Record<string, RawBreakdownParts> = {};
  let flatSum = 0;

  const isEnabled = (key: keyof typeof acts): boolean =>
    acts[key].enabled && acts[key].frequency > 0;
  const freq = (key: keyof typeof acts): number =>
    isEnabled(key) ? acts[key].frequency : 0;

  // Score activities via the registry
  const activityKeys = [
    'timeOnSite',
    'watchTwitch',
    'steamQuests',
    'dailyCalendar',
    'discordPoll',
    'dailyQuests',
    'steamCommunityEvent',
  ] as const;

  for (const key of activityKeys) {
    if (!isEnabled(key)) {
      continue;
    }
    const module = ACTIVITIES[key];
    const opps = module.opportunities({
      state: siteState,
      bonuses,
      nowMs: now,
      waitMs,
      steamRewardMode: 'scrapedOnly',
      frequency: freq(key),
    });
    if (opps.length > 0) {
      flatSum += scoreActivityOpportunities(breakdown, opps);
    }
  }

  // Battle pass claims scoring — NOT an ActivityKey, stays as a special case
  const readyClaims = battlePassClaimableArp(siteState.battlePass);
  if (readyClaims > 0 && !shouldDeferBattlePassForContext(context)) {
    const owned = resolveOwnedList(context);
    const hasAllArpOn = hasAllArpEffect(currentLoadout(owned));
    if (!hasAllArpOn || bonuses.allArpPct > 0) {
      flatSum += setBreakdownParts(
        breakdown,
        'battlePassClaims',
        readyClaims * BATTLE_PASS_BOOST_ARP,
      );
    }
  }

  return { flatSum, breakdown };
}

export function comboMarketDiscountPct(combo: ScoredCombo | undefined): number {
  return combo?.marketDiscountPct ?? 0;
}

export function pickHighestWeeklyArpCombo(
  ...combos: (ScoredCombo | undefined)[]
): ScoredCombo | undefined {
  let best: ScoredCombo | undefined;
  for (const combo of combos) {
    if (!combo) {
      continue;
    }
    if (!best || combo.weeklyArp > best.weeklyArp) {
      best = combo;
    }
  }
  return best;
}

/**
Per-activity lock-window ARP deltas from an ARP-optimal loadout to a
market-discount loadout. Positive `delta` is ARP left on the table.
*/
export function lockWindowArpLossLines(
  arpBest: ScoredCombo,
  discount: ScoredCombo,
): ArpLossLine[] {
  const keys = new Set([
    ...Object.keys(arpBest.breakdown),
    ...Object.keys(discount.breakdown),
  ]);
  const lines: ArpLossLine[] = [];
  for (const key of keys) {
    const from = arpBest.breakdown[key]?.total ?? 0;
    const to = discount.breakdown[key]?.total ?? 0;
    const delta = from - to;
    if (delta === 0) {
      continue;
    }
    lines.push({ key, from, to, delta });
  }
  return lines.toSorted(
    (left, right) => Math.abs(right.delta) - Math.abs(left.delta),
  );
}

/**
Current redeemable ARP plus the best remaining 24h-window earnings among the
given loadouts (quests / dailies still left). Undefined when balance is unknown.
*/
export function projectedRedeemableArp(
  context: OptimizerContext,
  ...windows: (ScoredCombo | undefined)[]
): number | undefined {
  const current = context.siteState.arpLog?.redeemableArp;
  if (current === undefined) {
    return undefined;
  }
  const earnable = Math.max(
    0,
    ...windows.map((combo) => combo?.weeklyArp ?? 0),
  );
  return current + earnable;
}

export function vaultListPrice(
  context: OptimizerContext,
  discountPct = 0,
): number {
  return context.settings.pendingVaultPurchaseArp > 0 ? context.settings.pendingVaultPurchaseArp : gameVaultCatalogPrice(
    context.siteState,
    discountPct,
    resolveNow(context),
  );
}

/**
List price only while Game Vault has a claim this combo can actually afford.
*/
export function vaultPurchasePriceNow(
  context: OptimizerContext,
  discountPct = 0,
): number {
  const now = resolveNow(context);
  if (!isGameVaultCurrentlyOpen(context.siteState, discountPct, now)) {
    return 0;
  }
  const price = vaultListPrice(context, discountPct);
  return (price <= 0) || !canAffordVaultPrice(
      context.siteState.arpLog?.redeemableArp,
      vaultPayArp(price, discountPct),
    ) ? 0 : price;
}

/**
Holistic combo score for the next 24h swap window.

Artifacts lock for 24h after they go on, so the window is remaining today
plus every known reset that still lands while worn — including a 00:00 UTC
daily that happens after a delayed All-ARP% equip, and the Monday Steam
Quest week. Goal is lifetime ARP, not only the rest of this UTC day.

Stacking order (confirmed by guide math + FAQ):
  totalArp = Σ(base + flatCategoryBonus) × (1 + Σ AllArpPct)

AllArpPct is a blanket multiplier over every ARP source — including categories
with no dedicated artifact (Steam Community Event Reward, Battle Pass claims).
MarketDiscountPct is scored separately as ARP savings, not as a multiplier.
*/
export function scoreCombo(
  three: OwnedArtifact[],
  context: OptimizerContext,
  waitMsOverride?: number,
): ScoredCombo {
  const bonuses = collectBonuses(three);
  const owned = resolveOwnedList(context);
  const now = resolveNow(context);
  const waitMs =
    waitMsOverride ??
    comboEquipWaitMs(
      three,
      owned,
      context.settings,
      context.snapshot.slotLocks,
      now,
    );
  const { flatSum, breakdown: rawBreakdown } = scoreWindowActivities(
    bonuses,
    context,
    waitMs,
  );
  const multiplier = 1 + bonuses.allArpPct;
  const windowArp = flatSum * multiplier;

  const breakdown: Record<string, BreakdownLine> = {};
  for (const [key, raw] of Object.entries(rawBreakdown)) {
    const preMultiplier = raw.base + raw.categoryBonus;
    const total = Math.round(preMultiplier * multiplier);
    const base = Math.round(raw.base);
    const categoryBonus = Math.round(raw.categoryBonus);
    breakdown[key] = {
      total,
      base,
      categoryBonus,
      allArpBonus: total - base - categoryBonus,
    };
  }

  const vaultPrice = vaultPurchasePriceNow(context, bonuses.marketDiscountPct);
  const marketplaceSavingsArp = vaultPrice * bonuses.marketDiscountPct;

  return {
    artifacts: three,
    weeklyArp: Math.round(windowArp),
    marketplaceSavingsArp: Math.round(marketplaceSavingsArp),
    totalScore: Math.round(windowArp + marketplaceSavingsArp),
    allArpPct: bonuses.allArpPct,
    steamQuestsFlat: bonuses.steamQuests,
    watchTwitchFlat: bonuses.watchTwitch,
    dailyCalendarFlat: bonuses.dailyCalendar,
    discordPollFlat: bonuses.discordPoll,
    marketDiscountPct: bonuses.marketDiscountPct,
    activeSetNames: activeSets(three.map((a) => a.familyId)).map((s) => s.name),
    breakdown,
  };
}
