import { BASE_ACTIVITY } from '../../src/artifacts/data';
import { collectBonuses } from '../../src/artifacts/optimizer/bonuses';
import {
  buildContext,
  comboEquipWaitMs,
  currentLoadout,
  isSameLoadout,
  resolveOwnedList,
} from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import {
  battlePassClaimableArp,
  isCommunityGateMet,
  isPersonalHoursMet,
} from '../../src/artifacts/siteState';
import {
  estimateCommunityUnlockAt,
  nextCommunityUnlockTarget,
} from '../../src/artifacts/siteState/communityEvent';
import { buildActionPlan, type ActionTodo } from '../../src/artifacts/ui/actionPlan';
import type { PersonaFixture } from '../fixtures/artifactFactory';
import { ALL_PERSONAS } from '../fixtures/personas/index';
import { ALL_SCENARIOS } from '../fixtures/scenarios/index';
import { MONTH_START_MS } from '../fixtures/scenarios/shared';
import {
  assertNoViolations,
  runOptimizerAudit,
} from '../audit/invariants';
import {
  COOLDOWN_MS,
  defaultArtifactSettings,
  type ArtifactOptimizerSettings,
  type ArtifactSlotPosition,
} from '../../src/artifacts/settings';
import type { ArtifactSnapshot, OwnedArtifact } from '../../src/artifacts/scraper';
import {
  isActivityAvailable,
  type SiteState,
} from '../../src/artifacts/siteState';
import type { ActivityKey } from '../../src/artifacts/siteState/types';
import type { OptimizerResult } from '../../src/artifacts/optimizer/types';

const MS_PER_DAY = 86_400_000;
export const SIM_DAYS = 30;

export interface ArpLedger {
  daily: number;
  community: number;
  battlePass: number;
}

export interface SimDayResult {
  day: number;
  nowMs: number;
  lifetimeArp: number;
  ledger: ArpLedger;
  equipped: readonly string[];
  violations: ReturnType<typeof runOptimizerAudit>['violations'];
}

export interface MonthSimResult {
  personaId: string;
  scenarioId: string;
  days: SimDayResult[];
  lifetimeArp: number;
  ledger: ArpLedger;
  violations: ReturnType<typeof runOptimizerAudit>['violations'];
}

interface LifetimeSimState {
  snapshot: ArtifactSnapshot;
  settings: ArtifactOptimizerSettings;
  lifetimeArp: number;
  ledger: ArpLedger;
  bpClaimed: boolean;
  /** Milestone indices already paid out in this run. */
  communityAwarded: Set<number>;
}

type SimStrategy = (
  result: OptimizerResult,
  todos: ActionTodo[],
  context: ReturnType<typeof buildContext>,
  state: LifetimeSimState,
  nowMs: number,
) => {
  equipLoadout?: readonly string[];
  claimBattlePass?: boolean;
};

function cloneArtifacts(artifacts: OwnedArtifact[]): OwnedArtifact[] {
  return artifacts.map((artifact) => ({ ...artifact }));
}

function equippedAllArpPct(snapshot: ArtifactSnapshot): number {
  const loadout = snapshot.artifacts.filter(
    (artifact) => artifact.equippedPosition !== undefined,
  );
  return collectBonuses(loadout).allArpPct;
}

function applyEquipLoadout(
  snapshot: ArtifactSnapshot,
  loadoutNames: readonly string[],
  nowMs: number,
  settings: ArtifactOptimizerSettings,
): {
  snapshot: ArtifactSnapshot;
  changedSlots: ArtifactSlotPosition[];
} {
  const nameSet = new Set(loadoutNames);
  const artifacts = cloneArtifacts(snapshot.artifacts);
  const previous = new Map<number, ArtifactSlotPosition | undefined>();
  for (const artifact of artifacts) {
    previous.set(artifact.instanceId, artifact.equippedPosition);
    delete artifact.equippedPosition;
    delete artifact.slotLocked;
  }
  let position = 1 as ArtifactSlotPosition;
  for (const artifact of artifacts) {
    if (nameSet.has(artifact.displayName)) {
      artifact.equippedPosition = position;
      position = (position + 1) as ArtifactSlotPosition;
    }
  }
  const changedSlots: ArtifactSlotPosition[] = [];
  for (const artifact of artifacts) {
    const before = previous.get(artifact.instanceId);
    const after = artifact.equippedPosition;
    if (before !== after && after !== undefined) {
      changedSlots.push(after);
    }
    if (before !== undefined && before !== after) {
      changedSlots.push(before);
    }
  }
  const uniqueSlots = [...new Set(changedSlots)];
  for (const slot of uniqueSlots) {
    settings.slotCooldowns.push({
      position: slot,
      changedAt: new Date(nowMs).toISOString(),
      estimated: true,
    });
  }
  return {
    snapshot: { ...snapshot, artifacts },
    changedSlots: uniqueSlots,
  };
}

function canEquipNow(
  loadout: OwnedArtifact[],
  snapshot: ArtifactSnapshot,
  settings: ArtifactOptimizerSettings,
  nowMs: number,
): boolean {
  const owned = snapshot.artifacts;
  const waitMs = comboEquipWaitMs(
    loadout,
    owned,
    settings,
    snapshot.slotLocks,
    nowMs,
  );
  return waitMs === 0;
}

function loadoutNames(artifacts: OwnedArtifact[]): string[] {
  return artifacts.map((artifact) => artifact.displayName);
}

/** Action-plan equip step loadout (dedicated field or headline suffix). */
function resolveEquipLoadout(todo: ActionTodo): string | undefined {
  if (todo.loadout) {
    return todo.loadout;
  }
  const match = /^.+ - (.+)$/.exec(todo.text);
  return match?.[1];
}

function earnDailyArp(
  snapshot: ArtifactSnapshot,
  siteState: SiteState,
  settings: ArtifactOptimizerSettings,
): number {
  const loadout = currentLoadout(snapshot.artifacts);
  if (loadout.length === 0) {
    return 0;
  }
  const bonuses = collectBonuses(loadout);
  const mult = 1 + bonuses.allArpPct;
  let total = 0;
  const add = (
    key: ActivityKey,
    basePerDay: number,
    flat: number,
  ): void => {
    const act = settings.activities[key];
    if (!act?.enabled || !isActivityAvailable(siteState.caps, key)) {
      return;
    }
    total += Math.round((basePerDay + flat) * mult * act.frequency);
  };
  add('watchTwitch', BASE_ACTIVITY.watchTwitchBasePerDay, bonuses.watchTwitch);
  add('timeOnSite', BASE_ACTIVITY.timeOnSiteBasePerDay, bonuses.timeOnSite);
  add(
    'dailyCalendar',
    BASE_ACTIVITY.dailyCalendarBasePerDay,
    bonuses.dailyCalendar,
  );
  if (
    settings.activities.dailyQuests?.enabled &&
    isActivityAvailable(siteState.caps, 'dailyQuests')
  ) {
    const day = new Date(siteState.updatedAt).getUTCDay();
    const weekend =
      day === 0 || day === 6 ? BASE_ACTIVITY.weekendQuestBase : 0;
    total += Math.round(
      (BASE_ACTIVITY.dailyQuestBase + weekend) *
        mult *
        (settings.activities.dailyQuests.frequency ?? 1),
    );
  }
  return total;
}

function awardCommunityMilestones(
  state: LifetimeSimState,
  siteState: SiteState,
): number {
  const event = siteState.communityEvent;
  if (!event?.isLive) {
    return 0;
  }
  const allArpPct = equippedAllArpPct(state.snapshot);
  let earned = 0;
  for (const milestone of event.milestones) {
    if (
      milestone.arpReward <= 0 ||
      state.communityAwarded.has(milestone.index) ||
      milestone.isAwarded
    ) {
      continue;
    }
    if (
      !isPersonalHoursMet(milestone, event.personalHours) ||
      !isCommunityGateMet(milestone, event.communityHours)
    ) {
      continue;
    }
    earned += Math.round(milestone.arpReward * (1 + allArpPct));
    state.communityAwarded.add(milestone.index);
  }
  return earned;
}

function awardBattlePass(
  state: LifetimeSimState,
  siteState: SiteState,
): number {
  if (state.bpClaimed) {
    return 0;
  }
  const base = battlePassClaimableArp(siteState.battlePass);
  if (base <= 0) {
    return 0;
  }
  const allArpPct = equippedAllArpPct(state.snapshot);
  state.bpClaimed = true;
  return Math.round(base * (1 + allArpPct));
}

/** Follow buildActionPlan — respects cooldowns via readyAtMs on equip steps. */
const guidedStrategy: SimStrategy = (_result, todos) => {
  const equipTodo = todos.find(
    (todo) =>
      todo.urgency?.chain === 'equip' &&
      (todo.urgency.readyAtMs ?? 0) === 0 &&
      resolveEquipLoadout(todo),
  );
  const claimTodo = todos.find(
    (todo) => todo.claimBattlePass === true && todo.claimBattlePassSkipArp !== true,
  );
  const decision: {
    equipLoadout?: readonly string[];
    claimBattlePass?: boolean;
  } = {};
  if (equipTodo) {
    const names = resolveEquipLoadout(equipTodo)
      ?.split(/\s*\+\s*/)
      .map((name) => name.trim());
    if (names && names.length > 0) {
      decision.equipLoadout = names;
    }
  }
  if (claimTodo) {
    decision.claimBattlePass = true;
  }
  return decision;
};

/**
 * Reference player with perfect foresight but real 24h slot cooldowns:
 * wear All-ARP% only for community gates / deferred swap / BP claim;
 * otherwise keep the best flat daily loadout when slots allow.
 */
const oracleStrategy: SimStrategy = (result, _todos, context, state, nowMs) => {
  const owned = resolveOwnedList(context);
  const equipped = currentLoadout(owned);
  const decision: {
    equipLoadout?: readonly string[];
    claimBattlePass?: boolean;
  } = {};

  let wantAllArp = false;

  const event = context.siteState.communityEvent;
  if (event?.isLive) {
    const target = nextCommunityUnlockTarget(event);
    if (target !== undefined) {
      const eta = estimateCommunityUnlockAt(event, target, nowMs);
      if (eta !== undefined && eta.etaMs <= COOLDOWN_MS) {
        wantAllArp = true;
      }
    }
  }

  if (result.deferredAllArp) {
    wantAllArp = true;
  }

  const bpBase = battlePassClaimableArp(context.siteState.battlePass);
  if (bpBase > 0 && !state.bpClaimed && result.deferBattlePassClaims !== true) {
    wantAllArp = true;
  }

  if (wantAllArp) {
    const allArpArtifacts =
      result.allArpLoadout?.artifacts ?? result.deferredAllArp?.artifacts;
    if (
      allArpArtifacts &&
      canEquipNow(allArpArtifacts, state.snapshot, state.settings, nowMs) &&
      !isSameLoadout(allArpArtifacts, equipped)
    ) {
      decision.equipLoadout = loadoutNames(allArpArtifacts);
      return decision;
    }
  }

  const flatBest =
    result.best && result.best.allArpPct === 0
      ? result.best.artifacts
      : (result.alternatives.find((combo) => combo.allArpPct === 0)?.artifacts ??
        result.current?.artifacts);
  if (
    flatBest &&
    canEquipNow(flatBest, state.snapshot, state.settings, nowMs) &&
    !isSameLoadout(flatBest, equipped)
  ) {
    decision.equipLoadout = loadoutNames(flatBest);
  }

  if (
    bpBase > 0 &&
    !state.bpClaimed &&
    result.deferBattlePassClaims !== true
  ) {
    decision.claimBattlePass = true;
  }

  return decision;
};

function runLifetimeSim(
  persona: PersonaFixture,
  scenarioId: string,
  scenario: (dayOffset: number, nowMs: number) => SiteState,
  strategy: SimStrategy,
  collectViolations: boolean,
): MonthSimResult {
  const state: LifetimeSimState = {
    snapshot: structuredClone(persona.snapshot),
    settings: structuredClone(defaultArtifactSettings),
    lifetimeArp: 0,
    ledger: { daily: 0, community: 0, battlePass: 0 },
    bpClaimed: false,
    communityAwarded: new Set(),
  };
  const days: SimDayResult[] = [];
  const allViolations: ReturnType<typeof runOptimizerAudit>['violations'] = [];

  for (let day = 0; day < SIM_DAYS; day += 1) {
    const nowMs = MONTH_START_MS + day * MS_PER_DAY + 8 * 3_600_000;
    const siteState = scenario(day, nowMs);
    const personaState: PersonaFixture = { ...persona, snapshot: state.snapshot };

    let violations: ReturnType<typeof runOptimizerAudit>['violations'] = [];
    let result: OptimizerResult;
    let todos: ActionTodo[] = [];

    if (collectViolations) {
      const audit = runOptimizerAudit(
        personaState,
        scenarioId,
        scenario,
        nowMs,
        state.settings,
      );
      result = audit.result;
      todos = audit.todos;
      violations = audit.violations;
      allViolations.push(...violations);
    } else {
      const context = buildContext(
        state.snapshot,
        state.settings,
        siteState,
        nowMs,
      );
      result = optimize(context);
      todos = buildActionPlan(result, state.settings, siteState);
    }

    const context = buildContext(
      state.snapshot,
      state.settings,
      siteState,
      nowMs,
    );
    const { equipLoadout, claimBattlePass } = strategy(
      result,
      todos,
      context,
      state,
      nowMs,
    );

    if (equipLoadout && equipLoadout.length > 0) {
      const owned = resolveOwnedList(context);
      const target = owned.filter((artifact) =>
        equipLoadout.includes(artifact.displayName),
      );
      if (
        target.length === 3 &&
        canEquipNow(target, state.snapshot, state.settings, nowMs)
      ) {
        state.snapshot = applyEquipLoadout(
          state.snapshot,
          equipLoadout,
          nowMs,
          state.settings,
        ).snapshot;
      }
    }

    const daily = earnDailyArp(state.snapshot, siteState, state.settings);
    const community = awardCommunityMilestones(state, siteState);
    const shouldClaimBp =
      claimBattlePass === true ||
      (battlePassClaimableArp(siteState.battlePass) > 0 &&
        !state.bpClaimed &&
        equippedAllArpPct(state.snapshot) > 0 &&
        result.deferBattlePassClaims !== true);
    const battlePass = shouldClaimBp
      ? awardBattlePass(state, siteState)
      : 0;

    state.ledger.daily += daily;
    state.ledger.community += community;
    state.ledger.battlePass += battlePass;
    state.lifetimeArp += daily + community + battlePass;

    days.push({
      day,
      nowMs,
      lifetimeArp: state.lifetimeArp,
      ledger: { ...state.ledger },
      equipped: currentLoadout(state.snapshot.artifacts).map(
        (artifact) => artifact.displayName,
      ),
      violations,
    });
  }

  return {
    personaId: persona.id,
    scenarioId,
    days,
    lifetimeArp: state.lifetimeArp,
    ledger: { ...state.ledger },
    violations: allViolations,
  };
}

/** Optimizer action-plan path with 24h cooldowns. */
export function simulateMonth(
  persona: PersonaFixture,
  scenarioId: string,
  scenario: (dayOffset: number, nowMs: number) => SiteState,
): MonthSimResult {
  return runLifetimeSim(persona, scenarioId, scenario, guidedStrategy, true);
}

/**
 * Reference lifetime-ARP player: same cooldown rules, smarter lump/BP timing.
 */
export function simulateOracleMonth(
  persona: PersonaFixture,
  scenarioId: string,
  scenario: (dayOffset: number, nowMs: number) => SiteState,
): MonthSimResult {
  return runLifetimeSim(persona, scenarioId, scenario, oracleStrategy, false);
}

/** @deprecated Use simulateOracleMonth — kept for compareToOracle callers. */
export function oracleLifetimeArp(
  persona: PersonaFixture,
  scenario: (dayOffset: number, nowMs: number) => SiteState,
): number {
  return simulateOracleMonth(persona, 'oracle', scenario).lifetimeArp;
}

export function compareCommunityLumps(
  guided: MonthSimResult,
  oracle: MonthSimResult,
): {
  guidedCommunity: number;
  oracleCommunity: number;
  missedArp: number;
  missedDays: { day: number; guidedGain: number; oracleGain: number }[];
} {
  const missedDays: { day: number; guidedGain: number; oracleGain: number }[] = [];
  for (let day = 0; day < guided.days.length; day += 1) {
    const guidedGain =
      guided.days[day]!.ledger.community -
      (guided.days[day - 1]?.ledger.community ?? 0);
    const oracleGain =
      oracle.days[day]!.ledger.community -
      (oracle.days[day - 1]?.ledger.community ?? 0);
    if (oracleGain > guidedGain) {
      missedDays.push({ day, guidedGain, oracleGain });
    }
  }
  return {
    guidedCommunity: guided.ledger.community,
    oracleCommunity: oracle.ledger.community,
    missedArp: oracle.ledger.community - guided.ledger.community,
    missedDays,
  };
}

export function compareToOracle(
  sim: MonthSimResult,
  persona: PersonaFixture,
  scenario: (dayOffset: number, nowMs: number) => SiteState,
): { simArp: number; oracleArp: number; delta: number; oracleLedger: ArpLedger } {
  const oracle = simulateOracleMonth(persona, sim.scenarioId, scenario);
  return {
    simArp: sim.lifetimeArp,
    oracleArp: oracle.lifetimeArp,
    delta: sim.lifetimeArp - oracle.lifetimeArp,
    oracleLedger: oracle.ledger,
  };
}

export { ALL_PERSONAS, ALL_SCENARIOS, assertNoViolations, COOLDOWN_MS };
