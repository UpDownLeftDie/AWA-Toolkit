import { describe, expect, it } from 'vitest';

import { buildContext, comboEquipWaitMs } from '../../src/artifacts/optimizer/context';
import { isAllArpWorthTheLock } from '../../src/artifacts/optimizer/search';
import {
  unconstrainedAllArpCombo,
} from '../../src/artifacts/optimizer/search';
import { resolveOwnedList } from '../../src/artifacts/optimizer/context';
import { defaultArtifactSettings } from '../../src/artifacts/settings';
import { communityTenArpLumpScenario } from '../fixtures/scenarios/communityOnly';
import { midZorathian } from '../fixtures/personas/index';
import { wednesdayMidWeekSteamCompleteMs } from '../fixtures/timeGrid';

describe('isAllArpWorthTheLock', () => {
  it('10 ARP lump at +10% All-ARP% is not worth a 12h slot lock vs Twitch flat', () => {
    const nowMs = wednesdayMidWeekSteamCompleteMs();
    const siteState = communityTenArpLumpScenario(0, nowMs);
    const settings = {
      ...defaultArtifactSettings,
      slotCooldowns: ([1, 2, 3] as const).map((position) => ({
        position,
        changedAt: new Date(nowMs - 12 * 3_600_000).toISOString(),
        estimated: true as const,
      })),
    };
    const context = buildContext(
      {
        ...midZorathian.snapshot,
        slotLocks: { 1: true, 2: true, 3: true },
      },
      settings,
      siteState,
      nowMs,
    );
    const owned = resolveOwnedList(context);
    const allArp = unconstrainedAllArpCombo(owned);
    expect(allArp).toBeDefined();
    const waitMs = comboEquipWaitMs(
      allArp!,
      owned,
      settings,
      { 1: true, 2: true, 3: true },
      nowMs,
    );
    expect(waitMs).toBeGreaterThan(0);
    expect(isAllArpWorthTheLock(allArp!, owned, context, waitMs)).toBe(false);
  });
});
