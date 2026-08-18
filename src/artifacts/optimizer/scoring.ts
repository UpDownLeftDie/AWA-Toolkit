import { BASE_ACTIVITY } from '../data';
import type { OwnedArtifact } from '../scraper';
import { COOLDOWN_MS } from '../settings';
import {
  battlePassClaimableArp,
  breakDownCommunityEventPending,
  canAffordVaultPrice,
  canEarnCommunityEventArp,
  estimateCommunityUnlockAt,
  isCommunityGateMet,
  isPersonalHoursMet,
  gameVaultCatalogPrice,
  isActivityAvailable,
  isActivityPending,
  isGameVaultCurrentlyOpen,
  remainingSteamQuestRewards,
  twitchWatchRemainingMs,
  vaultPayArp,
  type SiteState,
} from '../siteState';
import {
  addDailyCategory,
  type BonusBuckets,
  collectBonuses,
  setBreakdownParts,
} from './bonuses';
import {
  activeSets,
  currentLoadout,
  isResetInWearWindow,
  msUntilNextSteamQuestWeek,
  msUntilNextUtcMidnight,
  resolveOwnedList,
} from './context';
import { hasAllArpEffect, shouldDeferBattlePassForContext } from './search';
import type {
  BreakdownLine,
  OptimizerContext,
  RawBreakdownParts,
  ScoredCombo,
} from './types';

/**
 * Base ARP per ready Battle Pass ARP Boost (pre All-ARP% multiplier).
 */
export const BATTLE_PASS_BOOST_ARP = 40;

/**
 * A dedicated 24h All-ARP% lock is only worth it when the extra multiplier on
 * ready BP boosts beats the lock-window ARP lost vs the recommended set.
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

function scoreSteamQuestBases(
  breakdown: Record<string, RawBreakdownParts>,
  bonuses: BonusBuckets,
  freq: number,
  bases: number[],
): number {
  if (bases.length === 0) {
    return 0;
  }
  return setBreakdownParts(
    breakdown,
    'steamQuests',
    bases.reduce((sum, base) => sum + base, 0) * freq,
    bonuses.steamQuests * bases.length * freq,
  );
}

function scoreDailyQuests(
  breakdown: Record<string, RawBreakdownParts>,
  freq: number,
  onDay: Date,
): number {
  const B = BASE_ACTIVITY;
  let flatSum = setBreakdownParts(
    breakdown,
    'dailyQuests',
    B.dailyQuestBase * freq,
  );
  const day = onDay.getUTCDay();
  if (day === 0 || day === 6) {
    flatSum += setBreakdownParts(
      breakdown,
      'weekendQuests',
      B.weekendQuestBase * freq,
    );
  }
  return flatSum;
}

function scoreSecondaryActivities(
  breakdown: Record<string, RawBreakdownParts>,
  bonuses: BonusBuckets,
  context: OptimizerContext,
  isEnabled: (key: keyof OptimizerContext['settings']['activities']) => boolean,
  freq: (key: keyof OptimizerContext['settings']['activities']) => number,
): number {
  const { siteState } = context;
  const caps = siteState.caps;
  const B = BASE_ACTIVITY;
  let flatSum = 0;

  if (isEnabled('discordPoll') && isActivityPending(caps, 'discordPoll')) {
    const polls = B.discordPollsWhenPending * freq('discordPoll');
    flatSum += setBreakdownParts(
      breakdown,
      'discordPoll',
      B.discordPollBase * polls,
      bonuses.discordPoll * polls,
    );
  }

  if (isEnabled('dailyQuests')) {
    if (isActivityPending(caps, 'dailyQuests')) {
      flatSum += scoreDailyQuests(breakdown, freq('dailyQuests'), new Date());
    } else if (isResetInWearWindow(msUntilNextUtcMidnight())) {
      const nextDay = new Date(Date.now() + msUntilNextUtcMidnight());
      flatSum += scoreDailyQuests(breakdown, freq('dailyQuests'), nextDay);
    }
  }

  if (isEnabled('steamCommunityEvent')) {
    const eventArp = communityEventArpInSwapWindow(siteState);
    if (eventArp > 0) {
      flatSum += setBreakdownParts(
        breakdown,
        'steamCommunityEvent',
        eventArp * freq('steamCommunityEvent'),
      );
    }
  }

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

  return flatSum;
}

/**
 * Community Event ARP that this 24h lock will still be wearing when it grants.
 *
 * Personal-hours-not-met: player-controlled — score it (equip All-ARP% first).
 * Waiting-on-community: per milestone, only if that gate's ASCE ETA is inside
 * COOLDOWN_MS (75k in ~16h counts; 85k a day later does not). The award fires
 * on whatever is equipped; All-ARP% is the only boost (Megumin FAQ). Watch
 * Twitch repeats daily — it must not beat this one-shot. Unknown ETA stays
 * unscored. Both-gates-met is scrape lag — ignore.
 */
export function communityEventArpInSwapWindow(siteState: SiteState): number {
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
    if (eta !== undefined && eta.etaMs <= COOLDOWN_MS) {
      arp += milestone.arpReward;
    }
  }
  return arp;
}

function scoreWindowActivities(
  bonuses: BonusBuckets,
  context: OptimizerContext,
): { flatSum: number; breakdown: Record<string, RawBreakdownParts> } {
  const { settings, siteState } = context;
  const acts = settings.activities;
  const caps = siteState.caps;
  const B = BASE_ACTIVITY;
  const breakdown: Record<string, RawBreakdownParts> = {};
  let flatSum = 0;

  const isEnabled = (key: keyof typeof acts): boolean =>
    (acts[key]?.enabled ?? false) && (acts[key]?.frequency ?? 0) > 0;
  const freq = (key: keyof typeof acts): number =>
    isEnabled(key) ? (acts[key]?.frequency ?? 0) : 0;

  const isNextUtcResetInLock = isResetInWearWindow(msUntilNextUtcMidnight());

  if (
    isEnabled('timeOnSite') &&
    (isNextUtcResetInLock || isActivityAvailable(caps, 'timeOnSite'))
  ) {
    flatSum += addDailyCategory(
      breakdown,
      'timeOnSite',
      B.timeOnSiteBasePerDay,
      bonuses.timeOnSite,
      B.days,
      freq('timeOnSite'),
    );
  }

  if (isEnabled('watchTwitch')) {
    let twitchArp =
      twitchWatchRemainingMs(siteState, bonuses.watchTwitch) / 60_000;
    if (isNextUtcResetInLock && twitchArp <= 0) {
      const capArp = siteState.watchTwitch?.capArp ?? B.watchTwitchBasePerDay;
      twitchArp = capArp + bonuses.watchTwitch;
    }
    if (twitchArp > 0) {
      flatSum += setBreakdownParts(breakdown, 'watchTwitch', twitchArp);
    }
  }

  if (isEnabled('steamQuests')) {
    if (isActivityPending(caps, 'steamQuests')) {
      flatSum += scoreSteamQuestBases(
        breakdown,
        bonuses,
        freq('steamQuests'),
        remainingSteamQuestRewards(siteState),
      );
    } else if (isResetInWearWindow(msUntilNextSteamQuestWeek())) {
      flatSum += scoreSteamQuestBases(breakdown, bonuses, freq('steamQuests'), [
        ...B.steamQuestBases,
      ]);
    }
  }

  // Auto-claims on visit; ARP log marks today capped. Count the next day.
  if (isEnabled('dailyCalendar')) {
    flatSum += addDailyCategory(
      breakdown,
      'dailyCalendar',
      B.dailyCalendarBasePerDay,
      bonuses.dailyCalendar,
      B.days,
      freq('dailyCalendar'),
    );
  }

  flatSum += scoreSecondaryActivities(
    breakdown,
    bonuses,
    context,
    isEnabled,
    freq,
  );

  return { flatSum, breakdown };
}

export function comboMarketDiscountPct(combo: ScoredCombo | undefined): number {
  return combo?.marketDiscountPct ?? 0;
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
  if (context.settings.pendingVaultPurchaseArp > 0) {
    return context.settings.pendingVaultPurchaseArp;
  }
  return gameVaultCatalogPrice(context.siteState, discountPct);
}

/**
List price only while Game Vault has a claim this combo can actually afford.
*/
export function vaultPurchasePriceNow(
  context: OptimizerContext,
  discountPct = 0,
): number {
  if (!isGameVaultCurrentlyOpen(context.siteState, discountPct)) {
    return 0;
  }
  const price = vaultListPrice(context, discountPct);
  if (price <= 0) {
    return 0;
  }
  if (
    !canAffordVaultPrice(
      context.siteState.arpLog?.redeemableArp,
      vaultPayArp(price, discountPct),
    )
  ) {
    return 0;
  }
  return price;
}

/**
 * Holistic combo score for the next 24h swap window.
 *
 * Artifacts lock for 24h, so the window is remaining today plus known resets
 * that land while worn: next 00:00 UTC dailies when today is already capped,
 * and the Monday Steam Quest week when that reset falls inside the lock
 * (Sunday swaps). Goal is lifetime ARP, not only the rest of this UTC day.
 *
 * Stacking order (confirmed by guide math + FAQ):
 *   totalArp = Σ(base + flatCategoryBonus) × (1 + Σ AllArpPct)
 *
 * AllArpPct is a blanket multiplier over every ARP source — including categories
 * with no dedicated artifact (Steam Community Event Reward, Battle Pass claims).
 * MarketDiscountPct is scored separately as ARP savings, not as a multiplier.
 */
export function scoreCombo(
  three: OwnedArtifact[],
  context: OptimizerContext,
): ScoredCombo {
  const bonuses = collectBonuses(three);
  const { flatSum, breakdown: rawBreakdown } = scoreWindowActivities(
    bonuses,
    context,
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
