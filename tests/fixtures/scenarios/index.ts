import type { SiteState } from '../../../src/artifacts/siteState/types';
import { baselineScenario } from './baseline';
import { battlePassOnlyScenario } from './battlePassOnly';
import { communityOnlyScenario } from './communityOnly';

export function bothScenario(dayOffset: number, nowMs: number): SiteState {
  const community = communityOnlyScenario(dayOffset, nowMs);
  const battlePass = battlePassOnlyScenario(dayOffset, nowMs);
  if (battlePass.battlePass) {
    return {
      ...community,
      battlePass: battlePass.battlePass,
    };
  }
  return community;
}

export const ALL_SCENARIOS: readonly {
  id: string;
  label: string;
  fn: (dayOffset: number, nowMs: number) => SiteState;
}[] = [
  { id: 'baseline', label: 'No BP or community event', fn: baselineScenario },
  {
    id: 'battlePassOnly',
    label: 'Live battle pass, mid-month end',
    fn: battlePassOnlyScenario,
  },
  {
    id: 'communityOnly',
    label: 'Live ASCE-style community event',
    fn: communityOnlyScenario,
  },
  {
    id: 'both',
    label: 'Battle pass + community event',
    fn: bothScenario,
  },
];

export { baselineScenario, battlePassOnlyScenario, communityOnlyScenario };
