import { BASE_ACTIVITY } from '../../src/artifacts/data';
import {
  buildContext,
  isResetInWearWindow,
  msUntilNextSteamQuestWeek,
  resolveNow,
} from '../../src/artifacts/optimizer/context';
import { optimize } from '../../src/artifacts/optimizer/index';
import type { OptimizerResult, ScoredCombo } from '../../src/artifacts/optimizer/types';
import { COOLDOWN_MS } from '../../src/artifacts/settings';
import { scrapedRemainingSteamQuestRewards } from '../../src/artifacts/siteState/steamQuests';
import { buildActionPlan, type ActionTodo } from '../../src/artifacts/ui/actionPlan';
import type { PersonaFixture } from '../fixtures/artifactFactory';
import type { MonthScenario } from '../fixtures/scenarios/shared';
import { dayOffsetAt, isoAt } from '../fixtures/scenarios/shared';
import { defaultArtifactSettings } from '../../src/artifacts/settings';

export interface AuditContext {
  persona: PersonaFixture;
  scenarioId: string;
  nowMs: number;
}

export interface InvariantViolation {
  persona: string;
  scenario: string;
  nowIso: string;
  rule: string;
  detail: string;
  breakdown?: Record<string, unknown>;
}

function violation(
  ctx: AuditContext,
  rule: string,
  detail: string,
  breakdown?: Record<string, unknown>,
): InvariantViolation {
  return {
    persona: ctx.persona.id,
    scenario: ctx.scenarioId,
    nowIso: isoAt(ctx.nowMs),
    rule,
    detail,
    ...(breakdown && { breakdown }),
  };
}

function breakdownSum(breakdown: ScoredCombo['breakdown']): number {
  return Object.values(breakdown).reduce((sum, line) => sum + line.total, 0);
}

function steamFamilyIds(artifacts: ScoredCombo['artifacts']): string[] {
  return artifacts
    .map((artifact) => artifact.familyId)
    .filter((id) =>
      ['pn295-unstable-battery', 'sylphin-fission-blade'].includes(id),
    );
}

export function runOptimizerAudit(
  persona: PersonaFixture,
  scenarioId: string,
  scenario: MonthScenario,
  nowMs: number,
  settings = defaultArtifactSettings,
): {
  result: OptimizerResult;
  todos: ActionTodo[];
  violations: InvariantViolation[];
} {
  const siteState = scenario(dayOffsetAt(nowMs), nowMs);
  const context = buildContext(persona.snapshot, settings, siteState, nowMs);
  const result = optimize(context);
  const todos = buildActionPlan(result, settings, siteState);
  const auditCtx: AuditContext = { persona, scenarioId, nowMs };
  const violations = collectInvariantViolations(result, todos, auditCtx, context);
  return { result, todos, violations };
}

export function collectInvariantViolations(
  result: OptimizerResult,
  todos: ActionTodo[],
  ctx: AuditContext,
  context: ReturnType<typeof buildContext>,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const best = result.best;
  const current = result.current;
  const now = resolveNow(context);
  const siteState = context.siteState;

  if (best) {
    violations.push(...checkBreakdownTotals(best, ctx));
    violations.push(...checkSteamScoring(best, current, ctx, context, now));
  }

  violations.push(...checkDeferredAllArp(result, ctx));
  violations.push(...checkActionPlan(result, todos, ctx, now));

  const steamCapped = siteState.caps.steamQuests === 'capped';
  const remaining = scrapedRemainingSteamQuestRewards(siteState);
  if (steamCapped || remaining?.length === 0) {
    violations.push(...checkNoSteamOnlyDowngrade(result, ctx));
  }

  return violations;
}

function checkBreakdownTotals(
  best: ScoredCombo,
  ctx: AuditContext,
): InvariantViolation[] {
  const sum = breakdownSum(best.breakdown);
  const delta = Math.abs(sum - best.weeklyArp);
  // weeklyArp is Math.round(windowArp); per-line totals can drift by a few ARP.
  if (delta > 5) {
    return [
      violation(
        ctx,
        'breakdown-totals',
        `breakdown sum ${sum.toFixed(2)} != weeklyArp ${best.weeklyArp.toFixed(2)}`,
        { breakdown: best.breakdown, weeklyArp: best.weeklyArp },
      ),
    ];
  }
  return [];
}

function checkSteamScoring(
  best: ScoredCombo,
  current: ScoredCombo | undefined,
  ctx: AuditContext,
  context: ReturnType<typeof buildContext>,
  now: number,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const siteState = context.siteState;
  const steamLine = best.breakdown.steamQuests;
  const steamTotal = steamLine?.total ?? 0;
  const remaining = scrapedRemainingSteamQuestRewards(siteState);
  const steamCapped =
    siteState.caps.steamQuests === 'capped' ||
    (remaining !== undefined && remaining.length === 0);

  if (steamCapped && steamTotal > 0) {
    const waitMs = best.artifacts.length > 0 ? 0 : 0;
    const mondayMs = msUntilNextSteamQuestWeek(now);
    const inWindow = isResetInWearWindow(mondayMs, waitMs);
    if (!inWindow) {
      violations.push(
        violation(
          ctx,
          'steam-capped-no-phantom',
          `steam capped but breakdown.steamQuests=${steamTotal}`,
          { steamTotal, remaining },
        ),
      );
    }
  }

  const mondayMs = msUntilNextSteamQuestWeek(now);
  const waitMs = 0;
  if (
    waitMs + COOLDOWN_MS < mondayMs &&
    steamTotal >=
      [...BASE_ACTIVITY.steamQuestBases].reduce((sum, base) => sum + base, 0) *
        (1 + best.allArpPct)
  ) {
    violations.push(
      violation(
        ctx,
        'no-next-week-steam',
        `next-week 15+25+25 counted outside wear window (steamTotal=${steamTotal})`,
      ),
    );
  }

  if (steamCapped && steamFamilyIds(best.artifacts).length >= 2) {
    violations.push(
      violation(
        ctx,
        'no-steam-loadout-when-capped',
        `recommended steam-heavy loadout when week is complete: ${best.artifacts.map((a) => a.displayName).join(', ')}`,
      ),
    );
  }

  if (
    steamCapped &&
    current &&
    best.weeklyArp > current.weeklyArp + 50 &&
    steamFamilyIds(best.artifacts).length > 0 &&
    (current.watchTwitchFlat > best.watchTwitchFlat ||
      (current.breakdown.timeOnSite?.total ?? 0) >
        (best.breakdown.timeOnSite?.total ?? 0))
  ) {
    violations.push(
      violation(
        ctx,
        'no-steam-only-upgrade',
        `steam-only swap beats current by ${(best.weeklyArp - current.weeklyArp).toFixed(1)} ARP with no steam due`,
      ),
    );
  }

  return violations;
}

function checkDeferredAllArp(
  result: OptimizerResult,
  ctx: AuditContext,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  if (result.deferredAllArp === undefined) {
    const wearNote = result.notes.find((note) =>
      /wear.*all-arp/i.test(note),
    );
    if (wearNote) {
      violations.push(
        violation(
          ctx,
          'no-deferred-allarp-note',
          `note suggests wearing All-ARP% but deferredAllArp is undefined: ${wearNote}`,
        ),
      );
    }
  }
  return violations;
}

function checkNoSteamOnlyDowngrade(
  result: OptimizerResult,
  ctx: AuditContext,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const best = result.best;
  const current = result.current;
  if (!best || !current) {
    return violations;
  }
  const steamPick = steamFamilyIds(best.artifacts).length >= 1;
  const twitchLoss = best.watchTwitchFlat < current.watchTwitchFlat;
  if (steamPick && twitchLoss && !result.deferredSteam) {
    const isSameSteamCombo =
      steamFamilyIds(best.artifacts).length > 0 &&
      best.weeklyArp <= current.weeklyArp + 5;
    if (!isSameSteamCombo && best.weeklyArp > current.weeklyArp) {
      // Only flag when best is primarily a steam swap for 24h loadout
      if (
        best.steamQuestsFlat > current.steamQuestsFlat &&
        best.watchTwitchFlat <= current.watchTwitchFlat
      ) {
        violations.push(
          violation(
            ctx,
            'steam-capped-24h-pick',
            `24h pick drops Twitch flat for steam with week complete`,
            {
              best: best.artifacts.map((a) => a.displayName),
              current: current.artifacts.map((a) => a.displayName),
            },
          ),
        );
      }
    }
  }
  return violations;
}

function checkActionPlan(
  result: OptimizerResult,
  todos: ActionTodo[],
  ctx: AuditContext,
  now: number,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const siteState = buildContext(
    ctx.persona.snapshot,
    defaultArtifactSettings,
    undefined,
    ctx.nowMs,
  ).siteState;
  const steamCapped = siteState.caps.steamQuests === 'capped';
  const remaining = scrapedRemainingSteamQuestRewards(siteState);
  const noSteam =
    steamCapped || (remaining !== undefined && remaining.length === 0);

  if (noSteam) {
    const equipTodo = todos.find(
      (todo) =>
        todo.urgency?.chain === 'equip' &&
        /recycler|fission blade/i.test(`${todo.text} ${todo.loadout ?? ''}`),
    );
    if (equipTodo && (equipTodo.urgency?.readyAtMs ?? 0) === 0) {
      violations.push(
        violation(
          ctx,
          'action-plan-no-recycler-now',
          `first equip step recommends Recycler/Fission as immediate 24h loadout`,
          { todo: equipTodo.text },
        ),
      );
    }
  }

  const twitchAfterAllArp = todos.find(
    (todo) =>
      /watch twitch/i.test(todo.text) &&
      /all-arp|all arp/i.test(todo.text) &&
      result.current &&
      result.current.watchTwitchFlat >
        (result.best?.watchTwitchFlat ?? 0),
  );
  if (twitchAfterAllArp) {
    violations.push(
      violation(
        ctx,
        'action-plan-twitch-order',
        `schedules Watch Twitch after All-ARP% when current Twitch flat is better`,
        { todo: twitchAfterAllArp.text },
      ),
    );
  }

  void now;
  return violations;
}

export function assertNoViolations(violations: InvariantViolation[]): void {
  if (violations.length === 0) {
    return;
  }
  const message = violations
    .map(
      (v) =>
        `[${v.rule}] ${v.persona} + ${v.scenario} @ ${v.nowIso}: ${v.detail}`,
    )
    .join('\n');
  throw new Error(`Invariant violations:\n${message}`);
}
