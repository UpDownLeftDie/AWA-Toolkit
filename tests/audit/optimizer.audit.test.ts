import { describe, expect, it } from 'vitest';

import { COOLDOWN_MS } from '../../src/artifacts/settings';
import { steamWeekComplete } from '../fixtures/scenarios/baseline';
import { communityTenArpLumpScenario } from '../fixtures/scenarios/communityOnly';
import { ALL_SCENARIOS } from '../fixtures/scenarios/index';
import { ALL_PERSONAS, midPartialCooldown, midTwitchFocus, midZorathian } from '../fixtures/personas/index';
import { AUDIT_TIME_GRID, wednesdayMidWeekSteamCompleteMs } from '../fixtures/timeGrid';
import {
  assertNoViolations,
  runOptimizerAudit,
} from './invariants';
import { defaultArtifactSettings } from '../../src/artifacts/settings';

describe('optimizer audit grid', () => {
  for (const persona of ALL_PERSONAS) {
    for (const scenario of ALL_SCENARIOS) {
      describe(`${persona.id} × ${scenario.id}`, () => {
        for (const nowMs of AUDIT_TIME_GRID) {
          it(`passes invariants @ ${new Date(nowMs).toISOString()}`, () => {
            const { violations } = runOptimizerAudit(
              persona,
              scenario.id,
              scenario.fn,
              nowMs,
            );
            assertNoViolations(violations);
          });
        }
      });
    }
  }
});

describe('named regression cases', () => {
  it('midTwitchFocus + steam week complete + Wednesday → no Recycler 24h pick', () => {
    const nowMs = wednesdayMidWeekSteamCompleteMs();
    const { result, violations } = runOptimizerAudit(
      midTwitchFocus,
      'steamComplete',
      steamWeekComplete,
      nowMs,
    );
    const best = result.best;
    expect(best).toBeDefined();
    const steamFamilies = best?.artifacts.map((a) => a.familyId) ?? [];
    expect(steamFamilies).not.toContain('pn295-unstable-battery');
    expect(steamFamilies).not.toContain('sylphin-fission-blade');
    expect(best?.weeklyArp ?? 0).toBeLessThan(180);
    assertNoViolations(violations);
  });

  it('midZorathian + 10 ARP community lump + slot cooldown → no deferredAllArp', () => {
    const nowMs = wednesdayMidWeekSteamCompleteMs();
    const settings = {
      ...defaultArtifactSettings,
      slotCooldowns: ([1, 2, 3] as const).map((position) => ({
        position,
        changedAt: new Date(nowMs - 12 * 3_600_000).toISOString(),
        estimated: true as const,
      })),
    };
    const { result, violations } = runOptimizerAudit(
      {
        ...midZorathian,
        snapshot: {
          ...midZorathian.snapshot,
          slotLocks: { 1: true, 2: true, 3: true },
        },
      },
      'communityTenArp',
      communityTenArpLumpScenario,
      nowMs,
      settings,
    );
    expect(result.deferredAllArp).toBeUndefined();
    assertNoViolations(violations);
  });

  it('midPartialCooldown + slot 1 free → partial equip allowed, not steam-for-dailies', () => {
    const nowMs = wednesdayMidWeekSteamCompleteMs();
    const settings = {
      ...defaultArtifactSettings,
      slotCooldowns: ([2, 3] as const).map((position) => ({
        position,
        changedAt: new Date(nowMs - COOLDOWN_MS + 3_600_000).toISOString(),
        estimated: true as const,
      })),
    };
    const { result, violations } = runOptimizerAudit(
      midPartialCooldown,
      'baseline',
      ALL_SCENARIOS[0]!.fn,
      nowMs,
      settings,
    );
    expect(result.best).toBeDefined();
    const steamFamilies =
      result.best?.artifacts.map((artifact) => artifact.familyId) ?? [];
    expect(steamFamilies).not.toContain('pn295-unstable-battery');
    assertNoViolations(violations);
  });
});
