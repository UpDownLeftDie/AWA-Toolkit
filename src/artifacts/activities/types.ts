import type { BonusBuckets } from '../optimizer/bonuses';
import type { SiteState, ActivityKey } from '../siteState';

export type ActivityCadence = 'utcDaily' | 'weekly' | 'weekdayPoll' | 'event';
export type ActivityCompletion = 'instant' | 'timed' | 'autoClaim';

export interface Opportunity {
  /*
  Base ARP before flat category bonus and All-ARP%.
  */
  baseArp: number;
  /**
  Flat category bonus for this opportunity (pre-multiplier).
  */
  categoryBonus?: number;
  /**
  Wall-clock ms from `nowMs` when this opportunity starts (0 = now).
  */
  availableFromMs: number;
  /**
  Wall-clock ms from `nowMs` when it expires (omit if none).
  */
  availableUntilMs?: number;
  /**
  How long the user must spend once started (Twitch sit, ToS).
  */
  durationMs?: number;
  /**
  Breakdown key (e.g. 'steamQuests', 'weekendQuests').
  */
  breakdownKey: string;
}

export interface OpportunitiesInput {
  state: SiteState;
  bonuses: BonusBuckets;
  nowMs: number;
  /**
  Wait until this loadout can be equipped.
  */
  waitMs: number;
  /**
  Scoring uses scraped Steam rewards only (undefined → skip inventing a week).
  Planner UI may fall back to typical 15+25+25 — pass `steamRewardMode: 'typicalFallback'`.
  */
  steamRewardMode?: 'scrapedOnly' | 'typicalFallback';
  /**
  Frequency multiplier from settings (default 1).
  */
  frequency?: number;
  /**
  Horizon after equip (default COOLDOWN_MS = 24h).
  */
  horizonMs?: number;
}

export interface ActivityLabelContext {
  bonus: number;
  beforeSwap: boolean;
  utcDeadline: boolean;
  phase: 'before' | 'afterNow' | 'after' | 'other';
  waitMs: number;
  watchRemainingMs: number;
  utcDailyEndBufferMs: number;
  steamQuestCount?: number;
  dailyQuestPending?: readonly { kind: 'daily' | 'weekend' }[];
  nowMs: number;
  state: SiteState;
}

export interface ActivityModule {
  key: ActivityKey;
  cadence: ActivityCadence;
  completion: ActivityCompletion;
  bonusBucket?: keyof BonusBuckets;
  isDue(state: SiteState): boolean;
  opportunities(input: OpportunitiesInput): Opportunity[];
  /**
  Optional — used by planner labels; can stay thin wrappers.
  */
  label?(context: ActivityLabelContext): string;
}
