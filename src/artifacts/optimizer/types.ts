import type { ArtifactTier } from '../data';
import type { ArtifactSnapshot, OwnedArtifact } from '../scraper';
import type { ArtifactOptimizerSettings } from '../settings';
import type { SiteState } from '../siteState';

export interface BreakdownLine {
  /**
  Final ARP after All-ARP% multiplier.
  */
  total: number;
  /**
  Activity ARP before artifact flat bonus and All-ARP%.
  */
  base: number;
  /**
  Flat category bonus from artifacts + sets (pre-multiplier).
  */
  categoryBonus: number;
  /**
  All-ARP% uplift included in total.
  */
  allArpBonus: number;
}

export interface RawBreakdownParts {
  base: number;
  categoryBonus: number;
}

export interface ScoredCombo {
  artifacts: OwnedArtifact[];
  /**
  Estimated ARP for the 24h lock: remaining today plus UTC / Steam-week
  resets that still land while this loadout is worn.
  */
  weeklyArp: number;
  marketplaceSavingsArp: number;
  totalScore: number;
  allArpPct: number;
  /**
  Flat Steam Quests ARP bonus from artifacts + sets (pre-multiplier).
  */
  steamQuestsFlat: number;
  /**
  Flat Watch Twitch ARP bonus from artifacts + sets (pre-multiplier).
  */
  watchTwitchFlat: number;
  /**
  Flat Daily Calendar ARP bonus from artifacts + sets (pre-multiplier).
  */
  dailyCalendarFlat: number;
  /**
  Flat Discord Poll ARP bonus from artifacts + sets (pre-multiplier).
  */
  discordPollFlat: number;
  /**
  Combined market discount fraction from artifacts + sets (0.15 = 15% off).
  */
  marketDiscountPct: number;
  activeSetNames: string[];
  breakdown: Record<string, BreakdownLine>;
}

export interface UpgradeSuggestion {
  artifact: OwnedArtifact;
  fromTier: ArtifactTier;
  toTier: ArtifactTier;
  fragmentCost: number;
  /**
  Estimated extra ARP per month from this tier step (category uses / All-ARP%).
  */
  arpGain: number;
  efficiency: number;
  /**
  True when fragments cover this step without skipping a higher-priority save.
  */
  isAffordable: boolean;
}

export interface OptimizerResult {
  best: ScoredCombo | undefined;
  current: ScoredCombo | undefined;
  alternatives: ScoredCombo[];
  upgrades: UpgradeSuggestion[];
  /**
  Showroom lock icons — source of truth for slot lock state.
  */
  slotLocks?: Partial<Record<1 | 2 | 3, boolean>>;
  dailySwap:
    | {
        unequip: OwnedArtifact;
        equip: OwnedArtifact;
        reason: string;
      }
    | undefined;
  notes: string[];
  /**
  Inventory includes positive All-ARP% (artifact or set), not limited to top scored combos.
  */
  hasAllArpOwned?: boolean;
  /**
  Currently equipped loadout has positive All-ARP%.
  */
  hasAllArpEquipped?: boolean;
  /**
  Hold BP ARP Boosts while All-ARP% is off and the season still has time.
  Not a reason to swap onto All-ARP% unless a dedicated lock nets more ARP.
  False when already wearing it, or the season ends before All-ARP% can go on.
  */
  deferBattlePassClaims?: boolean;
  /**
  A dedicated 24h All-ARP% lock would net more lifetime ARP from ready BP
  boosts than it costs vs the recommended set. Used to offer that swap;
  claims still wait even when this is false (All-ARP% may go on later).
  */
  worthDedicatedAllArpForBattlePass?: boolean;
  /**
  Best owned loadout maximizing All-ARP% (HPC / Zorathian / etc.), for claim windows.
  Pinned to currently locked slots — empty when a lock blocks the set.
  */
  allArpLoadout?: ScoredCombo;
  /**
  Unconstrained All-ARP% set to wear once a lock expires, when a later
  community lump still grants after that wait. Hold the current loadout so
  a new 24h lock does not miss it.
  */
  deferredAllArp?: {
    waitMs: number;
    artifacts: OwnedArtifact[];
    unlock: {
      targetHours?: number;
      etaMs?: number;
      arpReward: number;
    };
  };
  /**
  Steam Quests remaining this week, but this 24h lock is not the last chance
  before Monday. Wear the Steam-flat set before starting quests — not as the
  24h recommended loadout.
  */
  deferredSteam?: {
    waitMs: number;
    artifacts: OwnedArtifact[];
  };
  /**
  Best owned loadout maximizing market discount (Stanley / Light Warping / etc.).
  */
  marketDiscountLoadout?: ScoredCombo;
  /**
  Megumin standing 3-set (wear all month), not the 24h remaining-activity combo.
  */
  monthlyMetaLoadout?: ScoredCombo;
  /**
  Game Vault discount rec for this rotation (dismissable).
  */
  vaultDiscount?: {
    cycleId: string;
    note?: string;
    dismissed: boolean;
  };
}

export interface OptimizerContext {
  snapshot: ArtifactSnapshot;
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
}
