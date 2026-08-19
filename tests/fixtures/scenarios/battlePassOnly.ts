import type { SiteState } from '../../../src/artifacts/siteState/types';
import { MONTH_START_MS, isoAt } from './shared';
import { baselineScenario } from './baseline';

const BP_END_MS = MONTH_START_MS + 15 * 86_400_000;

export function battlePassOnlyScenario(
  dayOffset: number,
  nowMs: number,
): SiteState {
  const base = baselineScenario(dayOffset, nowMs);
  if (nowMs >= BP_END_MS) {
    return base;
  }
  return {
    ...base,
    battlePass: {
      url: '/control-center/battle-pass/1',
      scrapedAt: isoAt(nowMs),
      readyToClaim: 2,
      readyToClaimArp: 30,
      endsAt: new Date(BP_END_MS).toISOString(),
    },
  };
}
