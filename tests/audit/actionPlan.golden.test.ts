import { describe, expect, it } from 'vitest';

import type { ActionTodo } from '../../src/artifacts/ui/actionPlan';
import { ALL_PERSONAS } from '../fixtures/personas/index';
import { ALL_SCENARIOS } from '../fixtures/scenarios/index';
import { AUDIT_TIME_GRID } from '../fixtures/timeGrid';
import { runOptimizerAudit } from './invariants';

/**
Stable, clock-independent fingerprint of a What-to-do plan for golden diffs.
*/
function fingerprintTodo(todo: ActionTodo): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    text: todo.text,
  };
  if (todo.kind !== undefined) {
    entry.kind = todo.kind;
  }
  if (todo.tone !== undefined) {
    entry.tone = todo.tone;
  }
  if (todo.loadout !== undefined) {
    entry.loadout = todo.loadout;
  }
  if (todo.equipCombo !== undefined) {
    entry.equipCombo = todo.equipCombo;
  }
  if (todo.claimBattlePass === true) {
    entry.claimBattlePass = true;
  }
  if (todo.claimBattlePassSkipArp === true) {
    entry.claimBattlePassSkipArp = true;
  }
  if (todo.startBattlePass === true) {
    entry.startBattlePass = true;
  }
  if (todo.openTwitchStream === true) {
    entry.openTwitchStream = true;
  }
  if (todo.upgradeInstanceId !== undefined) {
    entry.upgradeInstanceId = todo.upgradeInstanceId;
  }
  if (todo.openHref !== undefined) {
    entry.openHref = todo.openHref;
  }
  if (todo.visitInBackground === true) {
    entry.visitInBackground = true;
  }
  if (todo.reasons && todo.reasons.length > 0) {
    entry.reasons = todo.reasons.map((reason) =>
      reason.detail === undefined
        ? reason.text
        : { text: reason.text, detail: reason.detail },
    );
  }
  if (todo.urgency) {
    entry.urgency = {
      kind: todo.urgency.kind,
      readyAtMs: todo.urgency.readyAtMs,
      durationMs: todo.urgency.durationMs,
      ...(todo.urgency.deadlineMs !== undefined && {
        deadlineMs: todo.urgency.deadlineMs,
      }),
      ...(todo.urgency.arp !== undefined && { arp: todo.urgency.arp }),
      ...(todo.urgency.chain !== undefined && { chain: todo.urgency.chain }),
    };
  }
  return entry;
}

describe('action plan golden', () => {
  it('matches persona × scenario × time-grid fingerprints', () => {
    const goldens: Record<string, ReturnType<typeof fingerprintTodo>[]> = {};
    for (const persona of ALL_PERSONAS) {
      for (const scenario of ALL_SCENARIOS) {
        for (const nowMs of AUDIT_TIME_GRID) {
          const { todos } = runOptimizerAudit(
            persona,
            scenario.id,
            scenario.fn,
            nowMs,
          );
          const key = `${persona.id}|${scenario.id}|${new Date(nowMs).toISOString()}`;
          goldens[key] = todos.map(fingerprintTodo);
        }
      }
    }
    expect(goldens).toMatchSnapshot();
  });
});
