import { ArtifactEffectType, getArtifactById, getNumericEffect } from '../data';
import type { OwnedArtifact } from '../scraper';
import { activeSets } from './context';
import type { RawBreakdownParts } from './types';

export interface BonusBuckets {
  steamQuests: number;
  watchTwitch: number;
  dailyCalendar: number;
  timeOnSite: number;
  discordPoll: number;
  marketDiscountPct: number;
  allArpPct: number;
  communityPlaytimePct: number;
}

function emptyBonuses(): BonusBuckets {
  return {
    steamQuests: 0,
    watchTwitch: 0,
    dailyCalendar: 0,
    timeOnSite: 0,
    discordPoll: 0,
    marketDiscountPct: 0,
    allArpPct: 0,
    communityPlaytimePct: 0,
  };
}

function applyEffect(
  bonuses: BonusBuckets,
  type: ArtifactEffectType,
  value: number,
): void {
  switch (type) {
    case ArtifactEffectType.SteamQuests: {
      bonuses.steamQuests += value;
      break;
    }
    case ArtifactEffectType.WatchTwitch: {
      bonuses.watchTwitch += value;
      break;
    }
    case ArtifactEffectType.DailyCalendar: {
      bonuses.dailyCalendar += value;
      break;
    }
    case ArtifactEffectType.TimeOnSite: {
      bonuses.timeOnSite += value;
      break;
    }
    case ArtifactEffectType.DiscordPoll: {
      bonuses.discordPoll += value;
      break;
    }
    case ArtifactEffectType.MarketDiscountPct: {
      // Values are stored negative (e.g. -0.15); accumulate magnitude as savings fraction
      bonuses.marketDiscountPct += Math.abs(value);
      break;
    }
    case ArtifactEffectType.AllArpPct: {
      bonuses.allArpPct += value;
      break;
    }
    case ArtifactEffectType.CommunityPlaytimePct: {
      bonuses.communityPlaytimePct += value;
      break;
    }
    default: {
      break;
    }
  }
}

function applySetBonuses(bonuses: BonusBuckets, familyIds: string[]): void {
  for (const set of activeSets(familyIds)) {
    const arpEffects = set.effects.filter(
      (effect) => effect.unit !== 'cosmetic',
    );
    for (const effect of arpEffects) {
      applyEffect(bonuses, effect.type, effect.value);
    }
  }
}

export function collectBonuses(owned: OwnedArtifact[]): BonusBuckets {
  const bonuses = emptyBonuses();
  for (const item of owned) {
    const family = getArtifactById(item.familyId);
    if (!family) {
      continue;
    }
    applyEffect(
      bonuses,
      family.effectType,
      getNumericEffect(family, item.tier),
    );
  }
  applySetBonuses(
    bonuses,
    owned.map((artifact) => artifact.familyId),
  );
  return bonuses;
}

/**
 * Flats + All-ARP% for an arbitrary equipped set (including 1–2 pieces or a
 * post-immediate-equip mix). Used to decide whether filling a free slot would
 * actually hurt a pending activity.
 */
export interface ActivityLoadoutStats {
  allArpPct: number;
  steamQuestsFlat: number;
  watchTwitchFlat: number;
  dailyCalendarFlat: number;
  discordPollFlat: number;
}

export function activityStatsForArtifacts(
  artifacts: OwnedArtifact[],
): ActivityLoadoutStats {
  const bonuses = collectBonuses(artifacts);
  return {
    allArpPct: bonuses.allArpPct,
    steamQuestsFlat: bonuses.steamQuests,
    watchTwitchFlat: bonuses.watchTwitch,
    dailyCalendarFlat: bonuses.dailyCalendar,
    discordPollFlat: bonuses.discordPoll,
  };
}

export function setBreakdownParts(
  breakdown: Record<string, RawBreakdownParts>,
  key: string,
  base: number,
  categoryBonus = 0,
): number {
  const value = base + categoryBonus;
  if (value === 0) {
    return 0;
  }
  breakdown[key] = { base, categoryBonus };
  return value;
}

export function addDailyCategory(
  breakdown: Record<string, RawBreakdownParts>,
  key: string,
  base: number,
  flatBonus: number,
  days: number,
  frequency: number,
): number {
  return setBreakdownParts(
    breakdown,
    key,
    base * days * frequency,
    flatBonus * days * frequency,
  );
}
