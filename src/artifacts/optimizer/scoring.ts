import { BASE_ACTIVITY } from '../data';
import type { OwnedArtifact } from '../scraper';
import { COOLDOWN_MS } from '../settings';
import {
  battlePassClaimableArp,
  breakDownCommunityEventPending,
  canAffordVaultPrice,
  canEarnCommunityEventArp,
  estimateCommunityUnlockAt,
  gameVaultCatalogPrice,
  isActivityAvailable,
  isActivityPending,
  isCommunityGateMet,
  isGameVaultCurrentlyOpen,
  isPersonalHoursMet,
  scrapedRemainingSteamQuestRewards,
  twitchWatchRemainingMs,
  vaultPayArp,
  type SiteState,
} from '../siteState';
import {
  addDailyCategory,
  collectBonuses,
  setBreakdownParts,
  type BonusBuckets,
} from './bonuses';
import {
  activeSets,
  canCompleteInWearWindow,
  comboEquipWaitMs,
  completableUtcDayStarts,
  currentLoadout,
  isResetInWearWindow,
  isWeeklyForcedIntoLock,
  msUntilNextSteamQuestWeek,
  msUntilNextUtcMidnight,
  resolveNow,
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
  dayStartsMs: number[],
  now = Date.now(),
): number {
  if (dayStartsMs.length === 0) {
    return 0;
  }
  const B = BASE_ACTIVITY;
  let dailyBase = 0;
  let weekendBase = 0;
  for (const startMs of dayStartsMs) {
    const onDay = new Date(now + startMs);
    dailyBase += B.dailyQuestBase * freq;
    if (onDay.getUTCDay() === 0 || onDay.getUTCDay() === 6) {
      weekendBase += B.weekendQuestBase * freq;
    }
  }
  let flatSum = setBreakdownParts(breakdown, 'dailyQuests', dailyBase);
  if (weekendBase > 0) {
    flatSum += setBreakdownParts(breakdown, 'weekendQuests', weekendBase);
  }
  return flatSum;
}

function scoreSecondaryActivities(
  breakdown: Record<string, RawBreakdownParts>,
  bonuses: BonusBuckets,
  context: OptimizerContext,
  isEnabled: (key: keyof OptimizerContext['settings']['activities']) => boolean,
  freq: (key: keyof OptimizerContext['settings']['activities']) => number,
  waitMs: number,
  now: number,
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
    const questDays = completableUtcDayStarts(waitMs, 0, {
      todayAvailable: isActivityPending(caps, 'dailyQuests'),
      now,
    });
    flatSum += scoreDailyQuests(
      breakdown,
      freq('dailyQuests'),
      questDays,
      now,
    );
  }

  if (isEnabled('steamCommunityEvent')) {
    const eventArp = communityEventArpInSwapWindow(siteState, waitMs);
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
 * Waiting-on-community: per milestone, only if that gate's ASCE ETA lands
 * while this loadout is worn (`waitMs` until equip, then 24h). 75k in ~16h
 * with a 12h lock is a miss; 75k after a 16h wait still counts. The award
 * fires on whatever is equipped; All-ARP% is the only boost (Megumin FAQ).
 * Watch Twitch repeats daily — it must not beat this one-shot. Unknown ETA
 * stays unscored. Both-gates-met is scrape lag — ignore.
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

const TWITCH_MS_PER_ARP = 60_000;
const TIME_ON_SITE_DURATION_MS = BASE_ACTIVITY.timeOnSiteBasePerDay * 60_000;

function twitchArpInWearWindow(
  siteState: SiteState,
  twitchFlat: number,
  waitMs: number,
  now: number,
): number {
  const midnight = msUntilNextUtcMidnight(now);
  const todayRemaining = twitchWatchRemainingMs(siteState, twitchFlat) / 60_000;
  const fullDay =
    (siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) +
    twitchFlat;
  let twitchArp = 0;
  if (
    todayRemaining > 0 &&
    canCompleteInWearWindow(
      0,
      midnight,
      waitMs,
      todayRemaining * TWITCH_MS_PER_ARP,
    )
  ) {
    twitchArp += todayRemaining;
  }
  const laterDays = completableUtcDayStarts(
    waitMs,
    fullDay * TWITCH_MS_PER_ARP,
    { todayAvailable: false, now },
  );
  for (const dayStart of laterDays) {
    if (dayStart > 0) {
      twitchArp += fullDay;
    }
  }
  return twitchArp;
}

function steamBasesInWearWindow(
  siteState: SiteState,
  waitMs: number,
  now: number,
): number[] {
  const mondayResetMs = msUntilNextSteamQuestWeek(now);
  const steamBases: number[] = [];
  const remaining = scrapedRemainingSteamQuestRewards(siteState);
  // This week's quests last until Monday. Credit them to this 24h lock only
  // when they cannot be finished after it comes off — otherwise Recycler
  // steals a Time on Site day for Steam that can wait.
  if (
    remaining &&
    remaining.length > 0 &&
    isActivityPending(siteState.caps, 'steamQuests') &&
    isWeeklyForcedIntoLock(mondayResetMs, waitMs)
  ) {
    steamBases.push(...remaining);
  }
  // Next week's 15+25+25 only if Monday 00:00 UTC actually lands while worn.
  if (isResetInWearWindow(mondayResetMs, waitMs)) {
    steamBases.push(...BASE_ACTIVITY.steamQuestBases);
  }
  return steamBases;
}

function scoreWindowActivities(
  bonuses: BonusBuckets,
  context: OptimizerContext,
  waitMs: number,
): { flatSum: number; breakdown: Record<string, RawBreakdownParts> } {
  const { settings, siteState } = context;
  const now = resolveNow(context);
  const acts = settings.activities;
  const caps = siteState.caps;
  const B = BASE_ACTIVITY;
  const breakdown: Record<string, RawBreakdownParts> = {};
  let flatSum = 0;

  const isEnabled = (key: keyof typeof acts): boolean =>
    (acts[key]?.enabled ?? false) && (acts[key]?.frequency ?? 0) > 0;
  const freq = (key: keyof typeof acts): number =>
    isEnabled(key) ? (acts[key]?.frequency ?? 0) : 0;

  if (isEnabled('timeOnSite')) {
    const tosDays = completableUtcDayStarts(waitMs, TIME_ON_SITE_DURATION_MS, {
      todayAvailable: isActivityAvailable(caps, 'timeOnSite'),
      now,
    });
    if (tosDays.length > 0) {
      flatSum += addDailyCategory(
        breakdown,
        'timeOnSite',
        B.timeOnSiteBasePerDay,
        bonuses.timeOnSite,
        tosDays.length,
        freq('timeOnSite'),
      );
    }
  }

  if (isEnabled('watchTwitch')) {
    const twitchArp = twitchArpInWearWindow(
      siteState,
      bonuses.watchTwitch,
      waitMs,
      now,
    );
    if (twitchArp > 0) {
      flatSum += setBreakdownParts(breakdown, 'watchTwitch', twitchArp);
    }
  }

  if (isEnabled('steamQuests')) {
    const steamBases = steamBasesInWearWindow(siteState, waitMs, now);
    if (steamBases.length > 0) {
      flatSum += scoreSteamQuestBases(
        breakdown,
        bonuses,
        freq('steamQuests'),
        steamBases,
      );
    }
  }

  // Auto-claims on visit; ARP log marks today capped. Count midnights in wear.
  if (isEnabled('dailyCalendar')) {
    const calendarDays = completableUtcDayStarts(waitMs, 0, {
      todayAvailable: false,
      now,
    });
    if (calendarDays.length > 0) {
      flatSum += addDailyCategory(
        breakdown,
        'dailyCalendar',
        B.dailyCalendarBasePerDay,
        bonuses.dailyCalendar,
        calendarDays.length,
        freq('dailyCalendar'),
      );
    }
  }

  flatSum += scoreSecondaryActivities(
    breakdown,
    bonuses,
    context,
    isEnabled,
    freq,
    waitMs,
    now,
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
  return gameVaultCatalogPrice(
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
 * Artifacts lock for 24h after they go on, so the window is remaining today
 * plus every known reset that still lands while worn — including a 00:00 UTC
 * daily that happens after a delayed All-ARP% equip, and the Monday Steam
 * Quest week. Goal is lifetime ARP, not only the rest of this UTC day.
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
