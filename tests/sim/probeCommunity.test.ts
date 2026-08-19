import { describe, expect, it } from 'vitest';
import { midZorathian } from '../fixtures/personas/index';
import { communityTenArpLumpScenario } from '../fixtures/scenarios/communityOnly';
import {
  compareCommunityLumps,
  simulateMonth,
  simulateOracleMonth,
} from './monthSimulator';

describe('probe', () => {
  it('lump day awards', () => {
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
      `guided missed ${lumps.missedArp} community ARP on days ${lumps.missedDays.map((day) => day.day).join(', ')} (guided ${lumps.guidedCommunity} vs oracle ${lumps.oracleCommunity})`,
    ).toBe(0);
    expect(guided.ledger.community).toBeGreaterThanOrEqual(
      oracle.ledger.community,
    );
  });
});
