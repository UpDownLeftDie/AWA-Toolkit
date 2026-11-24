import { TIER_LABELS } from '../data';
import {
  activityStatsForArtifacts,
  type OptimizerResult,
  type ScoredCombo,
  type UpgradeSuggestion,
  VAULT_PRIORITY_DISCOUNT_PCT,
} from '../optimizer';
import type { OwnedArtifact } from '../scraper';
import {
  type ArtifactOptimizerSettings,
  COOLDOWN_MS,
  hasElapsedShowroomLock,
  STUCK_SLOT_LOCK_HINT,
} from '../settings';
import {
  breakDownCommunityEventPending,
  canEarnCommunityEventArp,
  isActivityAvailable,
  isActivityPending,
  type SiteState,
} from '../siteState';
import {
  isResetInWearWindow,
} from '../optimizer';
import { describeWaitingCommunityArpLine, formatCommunityEventArp } from '../siteState/communityEvent';
import {
  type LoadoutChangePlan,
  planLoadoutChanges,
} from '../optimizer/swapPlan';
import {
  artifactsForDisplay,
  comboLabel,
  formatMs,
  loadoutLabel,
  msUntilUtcMidnight,
} from '../loadoutFormat';
import {
  plannedEquipLabel,
} from '../optimizer/swapPlan';
import {
  msUntilNextSteamQuestWeek,
} from '../optimizer';
import type {
  ActionTodo,
  ActionTodoReason,
  ActionTodoUrgency,
  ActionTone,
  EquipComboKey,
} from './types';
import { actionUrgency } from './shared';

// ── Equip / swap helpers ───────────────────────────────────────────────

function flatBonusReason(
  amount: number,
  label: string,
  waitMs: number,
  nowMs: number,
): string {
  const isAfterUnlock = waitMs > msUntilUtcMidnight(new Date(nowMs));
  return isAfterUnlock
    ? `+${String(amount)} ${label} after unlock`
    : `+${String(amount)} ${label}`;
}

function pushAllArpEquipReasons(
  reasons: ActionTodoReason[],
  allArpPct: number,
  siteState: SiteState,
): void {
  if (allArpPct <= 0) {
    return;
  }
  const event = siteState.communityEvent;
  if (!event?.isLive || !canEarnCommunityEventArp(event)) {
    return;
  }
  const pending = breakDownCommunityEventPending(event);
  if (pending.waitingPersonalArp > 0) {
    reasons.push({
      text: `All-ARP% before personal Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp, allArpPct)})`,
    });
  } else if (pending.waitingCommunityArp > 0) {
    reasons.push({
      text: `All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp, allArpPct)})`,
    });
  }
}

function pushFlatEquipReason(
  reasons: ActionTodoReason[],
  amount: number,
  waitMs: number,
  isDueNow: boolean,
  isDueAfterReset: boolean,
  nowLabel: string,
  laterLabel: string,
  nowMs: number,
): void {
  if (amount <= 0 || (!isDueNow && !isDueAfterReset)) {
    return;
  }
  reasons.push({
    text: flatBonusReason(
      amount,
      isDueNow ? nowLabel : laterLabel,
      waitMs,
      nowMs,
    ),
  });
}

export function collectEquipReasons(
  siteState: SiteState,
  waitMs: number,
  stepArtifacts: OwnedArtifact[],
  options: {
    isPreloadNextUtcDay?: boolean;
    settings?: ArtifactOptimizerSettings;
    slotLocks?: OptimizerResult['slotLocks'];
    nowMs?: number;
  } = {},
): ActionTodoReason[] {
  const reasons: ActionTodoReason[] = [];
  const caps = siteState.caps;
  const stats = activityStatsForArtifacts(stepArtifacts);
  const isPreloadNextUtcDay = options.isPreloadNextUtcDay === true;
  const nowMs = options.nowMs ?? Date.now();

  pushAllArpEquipReasons(reasons, stats.allArpPct, siteState);

  if (stats.marketDiscountPct >= VAULT_PRIORITY_DISCOUNT_PCT) {
    reasons.push({
      text: `${String(Math.round(stats.marketDiscountPct * 100))}% Game Vault / marketplace discount before buying`,
    });
  }

  if (isPreloadNextUtcDay) {
    reasons.push({
      text: 'Start 24h lock before 00:00 UTC reset',
    });
  }

  const isNextUtcResetInLock = isResetInWearWindow(
    msUntilUtcMidnight(new Date(nowMs)),
    waitMs,
  );
  const isSteamDueNow = isActivityPending(caps, 'steamQuests');
  pushFlatEquipReason(
    reasons,
    stats.steamQuestsFlat,
    waitMs,
    isSteamDueNow,
    isPreloadNextUtcDay ||
      isResetInWearWindow(msUntilNextSteamQuestWeek(nowMs), waitMs),
    'Steam Quests',
    'Steam Quests after Monday reset',
    nowMs,
  );
  pushFlatEquipReason(
    reasons,
    stats.watchTwitchFlat,
    waitMs,
    isActivityAvailable(caps, 'watchTwitch'),
    isNextUtcResetInLock,
    'Watch Twitch cap',
    'Watch Twitch cap after 00:00 UTC',
    nowMs,
  );
  if (stats.discordPollFlat > 0 && isActivityPending(caps, 'discordPoll')) {
    reasons.push({
      text: flatBonusReason(
        stats.discordPollFlat,
        'Discord Poll',
        waitMs,
        nowMs,
      ),
    });
  }
  if (stats.dailyCalendarFlat > 0) {
    reasons.push({
      text: flatBonusReason(
        stats.dailyCalendarFlat,
        "Tomorrow's Daily Calendar ",
        waitMs,
        nowMs,
      ),
    });
  }
  if (
    options.settings &&
    hasElapsedShowroomLock(options.settings, options.slotLocks, nowMs)
  ) {
    reasons.push({
      text: STUCK_SLOT_LOCK_HINT,
    });
  }

  return reasons;
}

function comboArtifactsByIds(
  combo: NonNullable<OptimizerResult['best']>,
  ids: ReadonlySet<number>,
): OwnedArtifact[] {
  return combo.artifacts.filter((artifact) => ids.has(artifact.instanceId));
}

export function buildEquipTodo(options: {
  headline: string;
  loadout: string;
  reasons: ActionTodoReason[];
  tone?: ActionTone;
  urgency?: ActionTodoUrgency;
  equipCombo?: EquipComboKey;
}): ActionTodo {
  const { headline, loadout, reasons, tone, urgency, equipCombo } = options;
  const resolvedUrgency = urgency ?? {
    kind: 'action' as const,
    readyAtMs: 0,
    durationMs: 0,
    chain: 'equip' as const,
  };
  const todo: ActionTodo = {
    text: headline,
    loadout,
    urgency: resolvedUrgency,
  };
  if (reasons.length > 0) {
    todo.reasons = reasons;
  }
  if (tone) {
    todo.tone = tone;
  }
  if (
    equipCombo &&
    resolvedUrgency.kind === 'action' &&
    resolvedUrgency.readyAtMs <= 0 &&
    resolvedUrgency.chain === 'equip'
  ) {
    todo.equipCombo = equipCombo;
  }
  return todo;
}

export function deferredSteamTodo(
  deferred: NonNullable<OptimizerResult['deferredSteam']>,
  siteState: SiteState,
  nowMs: number,
): ActionTodo {
  const { waitMs, artifacts } = deferred;
  return buildEquipTodo({
    headline: deferredSteamSetHeadline(waitMs),
    loadout: loadoutLabel(artifactsForDisplay(deferred)),
    reasons: collectEquipReasons(siteState, waitMs, artifacts, { nowMs }),
    urgency: actionUrgency({
      kind: waitMs > 0 ? 'schedule' : 'action',
      readyAtMs: waitMs,
      durationMs: 0,
      deadlineMs: msUntilNextSteamQuestWeek(nowMs),
      chain: 'equip',
    }),
  });
}

function deferredSteamSetHeadline(waitMs: number): string {
  if (waitMs <= 0) {
    return 'Equip Steam Quests set now';
  }
  if (waitMs > COOLDOWN_MS) {
    return 'Equip Steam Quests set after this 24h wear';
  }
  return waitMs >= COOLDOWN_MS
    ? 'Equip Steam Quests set in 24h'
    : `Equip Steam Quests set in ${formatMs(waitMs)}`;
}

export function shouldFoldDeferredSteam(
  best: ScoredCombo | undefined,
  deferred: OptimizerResult['deferredSteam'],
  isNeedsSwap: boolean,
): boolean {
  return (
    isNeedsSwap && deferred !== undefined && (best?.steamQuestsFlat ?? 0) > 0
  );
}

function artifactsNotInOther(
  from: OwnedArtifact[],
  other: OwnedArtifact[],
): OwnedArtifact[] {
  const familyIds = new Set(other.map((artifact) => artifact.familyId));
  return from.filter((artifact) => !familyIds.has(artifact.familyId));
}

function deferredSteamFollowUpReason(
  deferred: NonNullable<OptimizerResult['deferredSteam']>,
  best: ScoredCombo,
): ActionTodoReason {
  const bonus = activityStatsForArtifacts(deferred.artifacts).steamQuestsFlat;
  const incoming = artifactsNotInOther(deferred.artifacts, best.artifacts);
  const incomingLabel = loadoutLabel(
    incoming.length > 0 ? incoming : artifactsForDisplay(deferred),
  );
  return {
    text: `Then ${incomingLabel} for +${String(bonus)} Steam`,
  };
}

function appendFoldedDeferredSteamReason(
  laterReasons: ActionTodoReason[],
  best: ScoredCombo,
  deferred: OptimizerResult['deferredSteam'],
): void {
  if (!deferred || !shouldFoldDeferredSteam(best, deferred, true)) {
    return;
  }
  laterReasons.push(deferredSteamFollowUpReason(deferred, best));
}

export function upgradeTodosFor(
  upgrades: UpgradeSuggestion[],
  instanceIds: ReadonlySet<number>,
): ActionTodo[] {
  const todos: ActionTodo[] = [];
  const seenAffordable = new Set<number>();
  for (const upgrade of upgrades) {
    if (!upgrade.isAffordable) {
      break;
    }
    const instanceId = upgrade.artifact.instanceId;
    if (!instanceIds.has(instanceId)) {
      continue;
    }
    const todo: ActionTodo = {
      text: `Upgrade ${upgrade.artifact.displayName} to ${TIER_LABELS[upgrade.toTier]} (${String(upgrade.fragmentCost)} frag)`,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        chain: 'equip',
      },
    };
    if (!seenAffordable.has(instanceId)) {
      seenAffordable.add(instanceId);
      todo.upgradeInstanceId = instanceId;
    }
    todos.push(todo);
  }
  return todos;
}

// ── Swap / equip plan helpers ──────────────────────────────────────────

function nowEquipLoadout(plan: LoadoutChangePlan): string {
  return plan.now.map((change) => plannedEquipLabel(change)).join(' + ');
}

function buildPartialEquipTodos(
  plan: LoadoutChangePlan,
  laterReasons: ActionTodoReason[],
): ActionTodo[] | undefined {
  if (plan.now.length === 0) {
    return undefined;
  }
  const nowTodo = buildEquipTodo({
    headline: 'Equip now',
    loadout: nowEquipLoadout(plan),
    reasons: [],
    equipCombo: 'best',
  });
  if (plan.laterNames.length > 0) {
    return [
      nowTodo,
      buildEquipTodo({
        headline: `Equip in ${formatMs(plan.waitMs)}`,
        loadout: plan.laterNames.join(' + '),
        reasons: laterReasons,
        urgency: {
          kind: 'schedule',
          readyAtMs: plan.waitMs,
          durationMs: 0,
          chain: 'equip',
        },
      }),
    ];
  }
  return plan.lockedSlots.length > 0 ? [nowTodo] : undefined;
}

function lockedSlotEquipTodos(options: {
  laterLabel: string;
  laterReasons: ActionTodoReason[];
  laterUpgrades: ActionTodo[];
  nowUpgrades: ActionTodo[];
  swapWaitMs: number;
  beforeSwapCount: number;
}): { immediate: ActionTodo[]; later: ActionTodo[] } {
  const {
    laterLabel,
    laterReasons,
    laterUpgrades,
    nowUpgrades,
    swapWaitMs,
    beforeSwapCount,
  } = options;
  if (swapWaitMs <= 0) {
    return {
      immediate: [
        ...nowUpgrades,
        buildEquipTodo({
          headline: beforeSwapCount > 0 ? 'Then equip' : 'Equip now',
          loadout: laterLabel,
          reasons: laterReasons,
          urgency: {
            kind: 'action',
            readyAtMs: 0,
            durationMs: 0,
            chain: 'equip',
          },
          equipCombo: 'best',
        }),
      ],
      later: laterUpgrades,
    };
  }
  return {
    immediate: nowUpgrades,
    later: [
      ...laterUpgrades,
      buildEquipTodo({
        headline: `Equip in ${formatMs(swapWaitMs)}`,
        loadout: laterLabel,
        reasons: laterReasons,
        urgency: {
          kind: 'schedule',
          readyAtMs: swapWaitMs,
          durationMs: 0,
          chain: 'equip',
        },
      }),
    ],
  };
}

export function buildSwapEquipTodos(options: {
  best: NonNullable<OptimizerResult['best']>;
  current: OptimizerResult['current'];
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  slotLocks?: Partial<Record<1 | 2 | 3, boolean>>;
  isLocked: boolean;
  waitMs: number;
  beforeSwapCount: number;
  upgrades: UpgradeSuggestion[];
  isPreloadNextUtcDay?: boolean;
  deferredSteam?: OptimizerResult['deferredSteam'];
  nowMs: number;
}): { immediate: ActionTodo[]; later: ActionTodo[] } {
  const {
    best,
    current,
    settings,
    siteState,
    slotLocks,
    isLocked,
    waitMs,
    beforeSwapCount,
    upgrades,
    isPreloadNextUtcDay = false,
    deferredSteam,
    nowMs,
  } = options;
  const plan = planLoadoutChanges(best.artifacts, current, settings, slotLocks, nowMs);
  const swapWaitMs = plan.waitMs > 0 ? plan.waitMs : waitMs;
  const laterIds = new Set(plan.later.map((change) => change.artifactId));
  const laterArtifacts = comboArtifactsByIds(best, laterIds);
  const laterReasons = collectEquipReasons(
    siteState,
    swapWaitMs,
    laterArtifacts.length > 0 ? laterArtifacts : best.artifacts,
    {
      isPreloadNextUtcDay,
      settings,
      slotLocks,
      nowMs,
    },
  );
  appendFoldedDeferredSteamReason(laterReasons, best, deferredSteam);
  const label = comboLabel(best);
  const nowUpgrades = upgradeTodosFor(
    upgrades,
    new Set(plan.now.map((change) => change.artifactId)),
  );
  const laterUpgrades = upgradeTodosFor(
    upgrades,
    new Set(plan.later.map((change) => change.artifactId)),
  );
  const partial = buildPartialEquipTodos(plan, laterReasons);
  if (partial && partial.length >= 2) {
    const [nowTodo, ...rest] = partial;
    return {
      immediate: nowTodo ? [...nowUpgrades, nowTodo] : nowUpgrades,
      later: [...laterUpgrades, ...rest],
    };
  }
  if (partial) {
    return {
      immediate: [...nowUpgrades, ...partial],
      later: laterUpgrades,
    };
  }
  if (isLocked) {
    const laterLabel =
      plan.laterNames.length > 0 ? plan.laterNames.join(' + ') : label;
    return lockedSlotEquipTodos({
      laterLabel,
      laterReasons,
      laterUpgrades,
      nowUpgrades,
      swapWaitMs,
      beforeSwapCount,
    });
  }
  return {
    immediate: [
      ...nowUpgrades,
      buildEquipTodo({
        headline: beforeSwapCount > 0 ? 'Then equip' : 'Equip now',
        loadout: nowEquipLoadout(plan) || label,
        reasons: laterReasons,
        urgency: {
          kind: 'action',
          readyAtMs: 0,
          durationMs: 0,
          chain: 'equip',
        },
        equipCombo: 'best',
      }),
    ],
    later: laterUpgrades,
  };
}

export function pushEquipPlanTodos(
  todos: ActionTodo[],
  options: {
    best: NonNullable<OptimizerResult['best']> | undefined;
    siteState: SiteState;
    isMatchingLoadout: boolean;
    isLocked: boolean;
    waitMs: number;
    hasOwnedAllArp: boolean;
    hasAllArpEquipped: boolean;
    upgrades: UpgradeSuggestion[];
  },
): void {
  const {
    best,
    siteState,
    isMatchingLoadout,
    isLocked,
    waitMs,
    hasOwnedAllArp,
    hasAllArpEquipped,
    upgrades,
  } = options;

  if (best && isMatchingLoadout) {
    const equippedIds = new Set(
      best.artifacts.map((artifact) => artifact.instanceId),
    );
    todos.push(...upgradeTodosFor(upgrades, equippedIds));
    return;
  }

  const event = siteState.communityEvent;
  const pending =
    event && canEarnCommunityEventArp(event)
      ? breakDownCommunityEventPending(event)
      : undefined;
  if (
    hasOwnedAllArp &&
    !hasAllArpEquipped &&
    isLocked &&
    pending &&
    pending.waitingPersonalArp > 0
  ) {
    todos.push({
      tone: 'warn',
      text: `Slots on cooldown (${formatMs(waitMs)} left)`,
      reasons: [
        {
          text: `Equip All-ARP% before playing Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp)} community-unlocked)`,
        },
      ],
      urgency: {
        kind: 'schedule',
        readyAtMs: waitMs,
        durationMs: 0,
        arp: pending.waitingPersonalArp,
        chain: 'equip',
      },
    });
    return;
  }
  if (
    hasOwnedAllArp &&
    !hasAllArpEquipped &&
    isLocked &&
    pending &&
    event &&
    pending.waitingCommunityArp > 0
  ) {
    todos.push({
      tone: 'muted',
      text: `Slots on cooldown (${formatMs(waitMs)} left)`,
      reasons: [
        {
          text: `Consider All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp)})`,
        },
      ],
      urgency: {
        kind: 'info',
        readyAtMs: waitMs,
        durationMs: 0,
        arp: pending.waitingCommunityArp,
      },
    });
  }
}
