import {
  battlePassClaimableArp,
  battlePassReadyNonArp,
  battlePassRemainingMs,
  breakDownCommunityEventPending,
  canEarnCommunityEventArp,
  type SiteState,
} from '../siteState';
import {
  shouldShowBattlePassClaimAll,
} from '../siteState/battlePass';
import { describeWaitingCommunityArpLine, formatCommunityEta, formatCommunityEventArp } from '../siteState/communityEvent';
import type { OwnedArtifact } from '../scraper';
import {
  type ArtifactOptimizerSettings,
  COOLDOWN_MS,
  showroomCooldownRemainingMs,
} from '../settings';
import {
  type OptimizerResult,
} from '../optimizer';
import {
  type LoadoutChangePlan,
} from '../optimizer/swapPlan';
import {
  artifactsForDisplay,
  formatMs,
  isSameLoadout,
  loadoutLabel,
} from '../loadoutFormat';
import type {
  ActionTodo,
  ActionTodoReason,
} from './types';
import { actionUrgency } from './shared';
import { buildEquipTodo } from './equipTodos';

// ── Battle Pass helpers ────────────────────────────────────────────────

function battlePassClaimCountLabel(readyAll: number, readyArp: number): string {
  if (readyArp <= 0) {
    return readyAll === 1
      ? '1 Battle Pass reward'
      : `${String(readyAll)} Battle Pass rewards`;
  }
  if (readyAll === readyArp) {
    return readyArp === 1
      ? '1 Battle Pass ARP Boost'
      : `${String(readyArp)} Battle Pass ARP Boosts`;
  }
  const boosts =
    readyArp === 1 ? '1 ARP Boost' : `${String(readyArp)} ARP Boosts`;
  return `${String(readyAll)} Battle Pass rewards (${boosts})`;
}

function holdArpBoostReason(readyArp: number): string {
  const arpLabel =
    readyArp === 1 ? '1 ARP Boost' : `${String(readyArp)} ARP Boosts`;
  return `Does not claim ${arpLabel} — those wait for All-ARP%`;
}

function nonArpBattlePassClaimLabel(nonArp: number): string {
  return nonArp === 1
    ? '1 cosmetic / fragment'
    : `${String(nonArp)} cosmetics / fragments`;
}

function pushHeldArpBattlePassTodos(
  todos: ActionTodo[],
  siteState: SiteState,
  readyArp: number,
  hasScheduledAllArp: boolean,
  allArpReadyAtMs = 0,
): void {
  const nonArp = battlePassReadyNonArp(siteState.battlePass);
  if (nonArp > 0) {
    const reasons: ActionTodoReason[] = [
      { text: holdArpBoostReason(readyArp) },
    ];
    if (!hasScheduledAllArp) {
      reasons.push({
        text: 'More boosts may unlock — claim those when All-ARP% is already on',
      });
    }
    todos.push({
      text: `Claim ${nonArpBattlePassClaimLabel(nonArp)} now (not ARP Boosts)`,
      reasons,
      claimBattlePass: true,
      claimBattlePassSkipArp: true,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        chain: 'before',
      },
    });
  }
  if (hasScheduledAllArp) {
    todos.push({
      text: `Claim ${battlePassClaimCountLabel(readyArp, readyArp)}`,
      urgency: {
        kind: 'schedule',
        readyAtMs: allArpReadyAtMs,
        durationMs: 0,
        arp: readyArp,
        chain: 'after',
      },
    });
  }
}

export function pushStartBattlePassTodo(
  todos: ActionTodo[],
  siteState: SiteState,
): void {
  const battlePass = siteState.battlePass;
  if (battlePass?.needsStart !== true) {
    return;
  }
  const todo: ActionTodo = {
    tone: 'warn',
    text: 'Start Battle Pass — new season (ARP only counts after Start)',
    reasons: [
      {
        text: 'Select Start Battle Pass on the track before farming ARP this season',
      },
    ],
    startBattlePass: true,
    urgency: {
      kind: 'action',
      readyAtMs: 0,
      durationMs: 0,
      chain: 'before',
    },
  };
  if (battlePass.url) {
    todo.openHref = battlePass.url;
    todo.openHrefLabel = 'Open Battle Pass';
  }
  todos.push(todo);
}

export function pushBattlePassTodo(
  todos: ActionTodo[],
  siteState: SiteState,
  options: {
    ownsAllArp: boolean;
    hasAllArpEquipped: boolean;
    afterAllArpEquipped?: boolean;
    allArpReadyAtMs?: number;
    seasonEndsBeforeAllArp?: boolean;
    nowMs?: number;
  },
): void {
  if (siteState.battlePass?.needsStart === true) {
    return;
  }
  const readyAll = siteState.battlePass?.readyToClaim ?? 0;
  if (readyAll <= 0) {
    return;
  }
  const readyArp = battlePassClaimableArp(siteState.battlePass);

  const {
    ownsAllArp,
    hasAllArpEquipped,
    afterAllArpEquipped = false,
    seasonEndsBeforeAllArp = false,
    allArpReadyAtMs = 0,
    nowMs = Date.now(),
  } = options;
  const shouldWaitForAllArpSwap =
    ownsAllArp && !hasAllArpEquipped && !seasonEndsBeforeAllArp;
  const shouldShowClaimAll = shouldShowBattlePassClaimAll(
    siteState.battlePass,
    shouldWaitForAllArpSwap,
  );
  const countLabel = battlePassClaimCountLabel(readyAll, readyArp);

  if (readyArp <= 0) {
    todos.push({
      text: `Claim ${countLabel}`,
      claimBattlePass: shouldShowClaimAll,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        chain: 'before',
      },
    });
    return;
  }

  if (hasAllArpEquipped) {
    todos.push({
      text: `Claim ${countLabel} now — All-ARP% is equipped`,
      claimBattlePass: shouldShowClaimAll,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        arp: readyArp,
        chain: 'before',
      },
    });
    return;
  }

  if (ownsAllArp && seasonEndsBeforeAllArp) {
    const left = battlePassRemainingMs(siteState.battlePass, nowMs);
    const todo: ActionTodo = {
      tone: 'warn',
      text: `Claim ${countLabel} now — Battle Pass ends before All-ARP% can be equipped`,
      claimBattlePass: shouldShowClaimAll,
      urgency: actionUrgency({
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        ...(typeof left === 'number' && { deadlineMs: left }),
        arp: readyArp,
        chain: 'before',
      }),
    };
    if (left !== undefined) {
      todo.reasons = [{ text: `Ends in ${formatMs(left)}` }];
    }
    todos.push(todo);
    return;
  }

  if (ownsAllArp) {
    pushHeldArpBattlePassTodos(
      todos,
      siteState,
      readyArp,
      afterAllArpEquipped,
      allArpReadyAtMs,
    );
    return;
  }

  todos.push({
    text: `Claim ${countLabel}`,
    claimBattlePass: shouldShowClaimAll,
    urgency: {
      kind: 'action',
      readyAtMs: 0,
      durationMs: 0,
      arp: readyArp,
      chain: 'before',
    },
  });
}

// ── All-ARP schedule / guard helpers ───────────────────────────────────

function allArpArtifactsFromResult(
  result: OptimizerResult,
): OwnedArtifact[] | undefined {
  const loadout = result.allArpLoadout;
  if (loadout && loadout.artifacts.length > 0 && loadout.allArpPct > 0) {
    return loadout.artifacts;
  }
  const deferred = result.deferredAllArp?.artifacts;
  return deferred && deferred.length > 0 ? deferred : undefined;
}

function battlePassAllArpEquipWaitMs(options: {
  result: OptimizerResult;
  plan: LoadoutChangePlan | undefined;
  isNeedsSwap: boolean;
  settings: ArtifactOptimizerSettings;
  allArpArtifacts: OwnedArtifact[];
  nowMs: number;
}): number {
  const { result, plan, isNeedsSwap, settings, allArpArtifacts, nowMs } = options;
  const best = result.best;
  const willWearOtherSetFirst =
    isNeedsSwap &&
    best !== undefined &&
    best.allArpPct <= 0 &&
    !isSameLoadout(best.artifacts, allArpArtifacts);
  if (willWearOtherSetFirst) {
    return (plan?.waitMs ?? 0) + COOLDOWN_MS;
  }

  const wearing = result.current?.artifacts;
  const targetIds = new Set(
    allArpArtifacts.map((artifact) => artifact.instanceId),
  );
  let waitMs = 0;
  for (const position of [1, 2, 3] as const) {
    const equipped = wearing?.find(
      (artifact) => artifact.equippedPosition === position,
    );
    if (equipped && targetIds.has(equipped.instanceId)) {
      continue;
    }
    waitMs = Math.max(
      waitMs,
      showroomCooldownRemainingMs(settings, position, {
        now: nowMs,
        ...(result.slotLocks && { slotLocks: result.slotLocks }),
        ...(typeof equipped?.slotLocked === 'boolean' && {
          equippedSlotLocked: equipped.slotLocked,
        }),
      }),
    );
  }
  return waitMs;
}

export function battlePassAllArpEquipTodo(options: {
  result: OptimizerResult;
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  plan: LoadoutChangePlan | undefined;
  isNeedsSwap: boolean;
  nowMs: number;
}): ActionTodo | undefined {
  const artifacts = allArpArtifactsFromResult(options.result);
  const waitMs = battlePassAllArpEquipWaitMs({
    result: options.result,
    plan: options.plan,
    isNeedsSwap: options.isNeedsSwap,
    settings: options.settings,
    allArpArtifacts: artifacts ?? [],
    nowMs: options.nowMs,
  });
  const arpReady = battlePassClaimableArp(options.siteState.battlePass);
  const headline =
    waitMs > 0 ? `Equip All-ARP% in ${formatMs(waitMs)}` : 'Equip All-ARP%';
  return buildEquipTodo({
    headline,
    loadout: artifacts
      ? loadoutLabel(
          artifactsForDisplay(
            options.result.allArpLoadout ??
              options.result.deferredAllArp ?? { artifacts },
          ),
        )
      : 'All-ARP% set',
    reasons: [],
    urgency: actionUrgency({
      kind: waitMs > 0 ? 'schedule' : 'action',
      readyAtMs: waitMs,
      durationMs: 0,
      ...(arpReady > 0 && { arp: arpReady }),
      chain: 'equip',
    }),
    equipCombo: 'allArp',
  });
}

export function battlePassAllArpSchedule(options: {
  result: OptimizerResult;
  plan: LoadoutChangePlan | undefined;
  isNeedsSwap: boolean;
  settings: ArtifactOptimizerSettings;
  waitMs: number;
  hasPlannedAllArp: boolean;
  shouldDeferBattlePassClaim: boolean;
  nowMs: number;
}): {
  hasScheduledAllArp: boolean;
  readyAtMs: number;
  shouldAddEquipTodo: boolean;
} {
  const deferred = options.result.deferredAllArp;
  const artifacts = allArpArtifactsFromResult(options.result);
  const shouldAddEquipTodo =
    options.shouldDeferBattlePassClaim &&
    options.result.worthDedicatedAllArpForBattlePass === true &&
    !options.hasPlannedAllArp &&
    deferred === undefined &&
    (artifacts !== undefined || options.result.hasAllArpOwned === true);
  const hasScheduledAllArp =
    options.hasPlannedAllArp || deferred !== undefined || shouldAddEquipTodo;

  if (options.hasPlannedAllArp) {
    return {
      hasScheduledAllArp,
      readyAtMs: options.waitMs,
      shouldAddEquipTodo,
    };
  }
  if (deferred) {
    return {
      hasScheduledAllArp,
      readyAtMs: deferred.waitMs,
      shouldAddEquipTodo,
    };
  }
  if (shouldAddEquipTodo && artifacts) {
    return {
      hasScheduledAllArp,
      readyAtMs: battlePassAllArpEquipWaitMs({
        result: options.result,
        plan: options.plan,
        isNeedsSwap: options.isNeedsSwap,
        settings: options.settings,
        allArpArtifacts: artifacts,
        nowMs: options.nowMs,
      }),
      shouldAddEquipTodo,
    };
  }
  if (shouldAddEquipTodo) {
    return {
      hasScheduledAllArp,
      readyAtMs:
        (options.plan?.waitMs ?? 0) + (options.isNeedsSwap ? COOLDOWN_MS : 0),
      shouldAddEquipTodo,
    };
  }
  return { hasScheduledAllArp, readyAtMs: 0, shouldAddEquipTodo };
}

// ── All-ARP guard helpers ──────────────────────────────────────────────

function pushCommunityAllArpGuards(
  todos: ActionTodo[],
  siteState: SiteState,
  isLocked: boolean,
  hasDeferredAllArp: boolean,
  allArpLoadout: OptimizerResult['allArpLoadout'],
): void {
  if (hasDeferredAllArp) {
    return;
  }
  const event = siteState.communityEvent;
  if (isLocked || !event || !canEarnCommunityEventArp(event)) {
    return;
  }
  const pending = breakDownCommunityEventPending(event);
  if (pending.waitingPersonalArp > 0) {
    const todo: ActionTodo = {
      tone: 'warn',
      text: `Equip All-ARP% before playing more Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp)} community-unlocked)`,
      urgency: {
        kind: 'action',
        readyAtMs: 0,
        durationMs: 0,
        arp: pending.waitingPersonalArp,
        chain: 'equip',
      },
    };
    if (allArpLoadout && allArpLoadout.allArpPct > 0) {
      todo.loadout = loadoutLabel(artifactsForDisplay(allArpLoadout));
      todo.equipCombo = 'allArp';
    }
    todos.push(todo);
    return;
  }
  if (pending.waitingCommunityArp <= 0) {
    return;
  }
  todos.push({
    tone: 'muted',
    text: `Consider All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp)})`,
    urgency: {
      kind: 'info',
      readyAtMs: 0,
      durationMs: 0,
      arp: pending.waitingCommunityArp,
    },
  });
}

export function pushAllArpGuardTodos(
  todos: ActionTodo[],
  siteState: SiteState,
  options: {
    ownsAllArp: boolean;
    hasAllArpEquipped: boolean;
    isLocked: boolean;
    deferBattlePassClaims: boolean;
    hasPlannedAllArp?: boolean;
    hasDeferredAllArp?: boolean;
    hasScheduledAllArp?: boolean;
    allArpLoadout?: OptimizerResult['allArpLoadout'];
  },
): void {
  const { ownsAllArp, hasAllArpEquipped, isLocked, deferBattlePassClaims } =
    options;
  if (!ownsAllArp || hasAllArpEquipped) {
    return;
  }
  const hasScheduledAllArp =
    options.hasScheduledAllArp === true || options.hasPlannedAllArp === true;
  if (
    deferBattlePassClaims &&
    battlePassClaimableArp(siteState.battlePass) > 0
  ) {
    const arpReady = battlePassClaimableArp(siteState.battlePass);
    todos.push({
      kind: 'caution',
      tone: hasScheduledAllArp ? 'warn' : 'muted',
      text: `Don't claim Battle Pass ARP Boost yet (${String(arpReady)} ready)`,
      reasons: [
        {
          text: hasScheduledAllArp
            ? 'Claim after All-ARP% is on'
            : 'More boosts may unlock — claim when All-ARP% is already on',
        },
      ],
    });
  }
  pushCommunityAllArpGuards(
    todos,
    siteState,
    isLocked,
    options.hasDeferredAllArp === true,
    options.allArpLoadout,
  );
}

// ── Scheduled All-ARP ──────────────────────────────────────────────────

function deferredAllArpTodo(
  deferred: NonNullable<OptimizerResult['deferredAllArp']>,
): ActionTodo {
  const { waitMs, unlock } = deferred;
  const parts: string[] = [];
  if (unlock.targetHours !== undefined) {
    parts.push(`Before ${unlock.targetHours.toLocaleString()}h`);
  }
  if (unlock.etaMs !== undefined) {
    parts.push(`ETA ${formatCommunityEta(unlock.etaMs)}`);
  }
  parts.push(formatCommunityEventArp(unlock.arpReward));
  return buildEquipTodo({
    headline: `Equip All-ARP% in ${formatMs(waitMs)}`,
    loadout: loadoutLabel(artifactsForDisplay(deferred)),
    reasons: [{ text: parts.join(' · ') }],
    urgency: actionUrgency({
      kind: 'schedule',
      readyAtMs: waitMs,
      durationMs: 0,
      ...(typeof unlock.etaMs === 'number' && { deadlineMs: unlock.etaMs }),
      arp: unlock.arpReward,
      chain: 'equip',
    }),
  });
}

export function pushScheduledAllArpTodos(
  todos: ActionTodo[],
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  plan: LoadoutChangePlan | undefined,
  isNeedsSwap: boolean,
  shouldAddBattlePassEquip: boolean,
  nowMs: number,
): void {
  const deferredAllArp = result.deferredAllArp;
  if (
    deferredAllArp &&
    !isSameLoadout(result.best?.artifacts ?? [], deferredAllArp.artifacts)
  ) {
    todos.push(deferredAllArpTodo(deferredAllArp));
    return;
  }
  if (deferredAllArp || !shouldAddBattlePassEquip) {
    return;
  }
  const allArpTodo = battlePassAllArpEquipTodo({
    result,
    settings,
    siteState,
    plan,
    isNeedsSwap,
    nowMs,
  });
  if (allArpTodo) {
    todos.push(allArpTodo);
  }
}
