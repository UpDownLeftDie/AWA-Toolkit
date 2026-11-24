import {
  BASE_ACTIVITY,
} from '../data';
import { MS_PER_MINUTE } from '../../core/time';
import {
  dailyQuestDayArp,
  timeOnSiteDayArp,
} from '../activities/dayArp';
import {
  type ActivityLoadoutStats,
  activityStatsForArtifacts,
  type OptimizerResult,
  type ScoredCombo,
} from '../optimizer';
import type { ActivityKey, SiteState } from '../siteState';
import {
  remainingSteamQuestRewards,
  twitchWatchRemainingMs,
} from '../siteState';
import type {
  ActionTodoChain,
  ActionTodoUrgency,
  ActionTodoUrgencyKind,
} from './types';

// ── Re-exports for other plan modules ──────────────────────────────────

export {
  hasAnySlotOnCooldown,
  maxSlotCooldownMs,
  planLoadoutChanges,
  type LoadoutChangePlan,
} from '../optimizer/swapPlan';
export { isSameLoadout } from '../loadoutFormat';
export type { ActivityKey } from '../siteState';

// ── Formatting (duplicated from ui/render to avoid plan → ui import) ──

const BREAKDOWN_LABELS: Record<string, string> = {
  timeOnSite: 'Time on Site',
  steamQuests: 'Steam Quests',
  watchTwitch: 'Watch Twitch',
  dailyCalendar: 'Daily Calendar',
  discordPoll: 'Discord Poll',
  dailyQuests: 'Daily quests',
  weekendQuests: 'Weekend quests',
  battlePassClaims: 'Battle Pass claims',
  steamCommunityEvent: 'Steam Community Event',
};

function breakdownLabel(key: string): string {
  return BREAKDOWN_LABELS[key] ?? key;
}

export function formatArpLossBreakdownLines(
  lines: { key: string; from: number; to: number; delta: number }[],
): string[] {
  return lines.map((line) => {
    const sign = line.delta > 0 ? '−' : '+';
    return `${breakdownLabel(line.key)}: ${String(line.from)} → ${String(line.to)} (${sign}${String(Math.abs(line.delta))})`;
  });
}

// ── Urgency helpers ────────────────────────────────────────────────────

export function actionUrgency(partial: {
  kind: ActionTodoUrgencyKind;
  readyAtMs: number;
  durationMs: number;
  deadlineMs?: number;
  arp?: number;
  chain?: ActionTodoChain;
}): ActionTodoUrgency {
  const urgency: ActionTodoUrgency = {
    kind: partial.kind,
    readyAtMs: partial.readyAtMs,
    durationMs: partial.durationMs,
  };
  if (partial.deadlineMs !== undefined) {
    urgency.deadlineMs = partial.deadlineMs;
  }
  if (partial.arp !== undefined) {
    urgency.arp = partial.arp;
  }
  if (partial.chain !== undefined) {
    urgency.chain = partial.chain;
  }
  return urgency;
}

// ── Activity types / constants ─────────────────────────────────────────

export type ActivityPhase = 'before' | 'afterNow' | 'after' | 'other';

export type LoadoutLike = ActivityLoadoutStats | ScoredCombo | undefined;

export type DiscordPollSlot = 'before' | 'afterNow' | 'afterFull' | 'other';

export interface PlannedWear {
  stats: ActivityLoadoutStats;
  waitMs: number;
}

export function plannedWearForResets(
  result: OptimizerResult,
  swapWaitMs: number,
): PlannedWear | undefined {
  const deferred = result.deferredAllArp;
  if (deferred && deferred.waitMs > 0 && deferred.artifacts.length > 0) {
    return {
      stats: activityStatsForArtifacts(deferred.artifacts),
      waitMs: deferred.waitMs,
    };
  }
  const steam = result.deferredSteam;
  if (steam && steam.artifacts.length > 0) {
    return {
      stats: activityStatsForArtifacts(steam.artifacts),
      waitMs: steam.waitMs,
    };
  }
  const best = result.best;
  const current = result.current;
  if (best && best.allArpPct > (current?.allArpPct ?? 0) && swapWaitMs > 0) {
    return {
      stats: activityStatsForArtifacts(best.artifacts),
      waitMs: swapWaitMs,
    };
  }
  return undefined;
}

// ── Loadout stat helpers ───────────────────────────────────────────────

export function loadoutStats(combo: LoadoutLike): ActivityLoadoutStats | undefined {
  if (!combo) {
    return undefined;
  }
  if ('artifacts' in combo && combo.artifacts.length > 0) {
    return activityStatsForArtifacts(combo.artifacts);
  }
  return 'timeOnSiteFlat' in combo ? combo : undefined;
}

export function comboBonusForActivity(combo: LoadoutLike, key: ActivityKey): number {
  if (!combo) {
    return 0;
  }
  switch (key) {
    case 'steamQuests': {
      return combo.steamQuestsFlat;
    }
    case 'watchTwitch': {
      return combo.watchTwitchFlat;
    }
    case 'discordPoll': {
      return combo.discordPollFlat;
    }
    case 'timeOnSite': {
      return loadoutStats(combo)?.timeOnSiteFlat ?? 0;
    }
    default: {
      return 0;
    }
  }
}

// ── Activity ARP helpers ───────────────────────────────────────────────

/**
ARP for a single wear-window for the given activity.
Pure day-ARP helpers (timeOnSiteDayArp, dailyQuestDayArp) from
activities/dayArp.ts are the shared source of truth for the numeric constants
used by both this planner helper and forcedDailyArpDelta in optimizer/search.ts.
steamQuests and watchTwitch have per-activity logic handled inline.
*/
export function activityWindowArp(
  combo: LoadoutLike,
  key: ActivityKey,
  siteState?: SiteState,
  nowMs = Date.now(),
): number {
  const stats = loadoutStats(combo);
  const allArpPct = stats?.allArpPct ?? combo?.allArpPct ?? 0;
  switch (key) {
    case 'watchTwitch': {
      const twitchFlat = stats?.watchTwitchFlat ?? comboBonusForActivity(combo, key);
      const base =
        siteState === undefined
          ? BASE_ACTIVITY.watchTwitchBasePerDay + twitchFlat
          : twitchWatchRemainingMs(siteState, twitchFlat) / MS_PER_MINUTE;
      return base * (1 + allArpPct);
    }
    case 'dailyQuests': {
      return dailyQuestDayArp({ allArpPct }, new Date(nowMs));
    }
    case 'timeOnSite': {
      const timeOnSiteFlat = stats?.timeOnSiteFlat ?? 0;
      return timeOnSiteDayArp({ allArpPct, timeOnSite: timeOnSiteFlat });
    }
    case 'steamQuests': {
      const bases = siteState
        ? remainingSteamQuestRewards(siteState)
        : [...BASE_ACTIVITY.steamQuestBases];
      const flat = stats?.steamQuestsFlat ?? comboBonusForActivity(combo, key);
      return (
        (bases.reduce((sum, value) => sum + value, 0) + flat * bases.length) *
        (1 + allArpPct)
      );
    }
    case 'discordPoll': {
      const flat = comboBonusForActivity(combo, key);
      return (BASE_ACTIVITY.discordPollBase + flat) * (1 + allArpPct);
    }
    default: {
      return 0;
    }
  }
}

export function bonusForActivityPhase(
  phase: ActivityPhase,
  currentBonus: number,
  bestBonus: number,
  afterNowBonus = 0,
): number {
  if (phase === 'after') {
    return bestBonus;
  }
  if (phase === 'afterNow') {
    return afterNowBonus;
  }
  return phase === 'before' ? currentBonus : 0;
}

// ── Re-exports needed by ui/render.ts ──────────────────────────────────

export { formatCommunityEta } from '../siteState/communityEvent';
