import { describe, expect, it } from 'vitest';

import { midZorathian } from '../fixtures/personas/index';
import { baselineScenario } from '../fixtures/scenarios/baseline';
import {
  communityOnlyScenario,
  communityTenArpLumpScenario,
} from '../fixtures/scenarios/communityOnly';
import {
  ALL_PERSONAS,
  ALL_SCENARIOS,
  assertNoViolations,
  compareCommunityLumps,
  compareToOracle,
  simulateMonth,
  simulateOracleMonth,
} from './monthSimulator';

describe('month lifetime ARP simulator', () => {
  for (const persona of ALL_PERSONAS) {
    for (const scenario of ALL_SCENARIOS) {
      it(`${persona.id} × ${scenario.id} — invariants + realistic oracle`, () => {
        const sim = simulateMonth(persona, scenario.id, scenario.fn);
        assertNoViolations(sim.violations);

        const { delta, oracleArp, oracleLedger } = compareToOracle(
          sim,
          persona,
          scenario.fn,
        );
        if (oracleArp > 0) {
          expect(
            delta,
            `guided ${sim.lifetimeArp} vs oracle ${oracleArp} (ledger ${JSON.stringify(sim.ledger)} vs ${JSON.stringify(oracleLedger)})`,
          ).toBeGreaterThanOrEqual(-oracleArp * 0.1);
        }
      });
    }
  }

  it('midZorathian community event pays more with All-ARP% on unlock than baseline', () => {
    const baseline = simulateOracleMonth(
      midZorathian,
      'baseline',
      baselineScenario,
    );
    const community = simulateOracleMonth(
      midZorathian,
      'communityOnly',
      communityOnlyScenario,
    );
    expect(community.ledger.community).toBeGreaterThan(0);
    expect(community.lifetimeArp).toBeGreaterThan(baseline.lifetimeArp);
    expect(community.ledger.community).toBeGreaterThanOrEqual(20);
  });

  it('guided path earns community lump ARP when event is live', () => {
    const sim = simulateMonth(
      midZorathian,
      'communityOnly',
      communityOnlyScenario,
    );
    expect(sim.ledger.community).toBeGreaterThan(0);
  });

  it('guided path captures All-ARP% community lumps the oracle would (10 ARP gate)', () => {
    const guided = simulateMonth(
      midZorathian,
      'communityTenArpLump',
      communityTenArpLumpScenario,
    );
    const oracle = simulateOracleMonth(
      midZorathian,
      'communityTenArpLump',
      communityTenArpLumpScenario,
    );
    const lumps = compareCommunityLumps(guided, oracle);

    expect(
      lumps.missedArp,
      `guided missed ${lumps.missedArp} community ARP on days ${lumps.missedDays.map((d) => d.day).join(', ')} (guided ${lumps.guidedCommunity} vs oracle ${lumps.oracleCommunity})`,
    ).toBe(0);
    expect(guided.ledger.community).toBeGreaterThanOrEqual(oracle.ledger.community);
  });
});
