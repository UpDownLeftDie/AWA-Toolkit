import { describe, expect, it } from 'vitest';

import { buildActionPlan } from '../../src/artifacts/plan/buildActionPlan';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import type { OptimizerResult } from '../../src/artifacts/optimizer/types';
import type { SiteState } from '../../src/artifacts/siteState/types';

const EMPTY_RESULT: OptimizerResult = {
  best: undefined,
  current: undefined,
  alternatives: [],
  activePolicyId: 'lifetimeArp',
  upgrades: [],
  dailySwap: undefined,
  notes: [],
};

const EMPTY_STATE: SiteState = {
  capsScrapedAt: new Date(0).toISOString(),
  caps: {
    timeOnSite: 'unknown',
    watchTwitch: 'unknown',
    dailyCalendar: 'unknown',
    dailyQuests: 'unknown',
    discordPoll: 'unknown',
    steamCommunityEvent: 'unknown',
    steamQuests: 'unknown',
  },
  gameVault: [],
  arpLog: {
    scrapedAt: new Date(0).toISOString(),
    redeemableArp: 0,
    recent: [],
  },
};

describe('achievements demerged from ARP plan', () => {
  it('does not emit achievement todos in the ARP action plan', () => {
    const todos = buildActionPlan(
      EMPTY_RESULT,
      {
        ...defaultArtifactSettings,
        achievementsEnabled: true,
      },
      EMPTY_STATE,
      Date.UTC(2026, 6, 21, 16, 0),
    );
    expect(
      todos.every(
        (todo) =>
          !/achievement|about me|first border|connect discord/i.test(todo.text),
      ),
    ).toBe(true);
  });
});
