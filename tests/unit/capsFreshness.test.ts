import { describe, expect, it } from 'vitest';

import { isCapsFresh } from '../../src/artifacts/remoteScrape';
import type { SiteState } from '../../src/artifacts/siteState/types';

function isoHoursAgo(hours: number, nowMs = Date.now()): string {
  return new Date(nowMs - hours * 60 * 60 * 1000).toISOString();
}

function siteState(overrides: Partial<SiteState> = {}): SiteState {
  return {
    capsScrapedAt: isoHoursAgo(1),
    caps: {
      timeOnSite: 'available',
      steamQuests: 'capped',
      watchTwitch: 'available',
      dailyCalendar: 'available',
      discordPoll: 'available',
      dailyQuests: 'available',
      steamCommunityEvent: 'capped',
    },
    gameVault: [],
    ...overrides,
  };
}

describe('isCapsFresh', () => {
  it('is stale when capsScrapedAt is missing', () => {
    const { capsScrapedAt: _dropped, ...withoutStamp } = siteState();
    expect(isCapsFresh(withoutStamp)).toBe(false);
  });

  it('is stale when capsScrapedAt is older than today / TTL', () => {
    expect(
      isCapsFresh(
        siteState({
          capsScrapedAt: isoHoursAgo(30),
        }),
      ),
    ).toBe(false);
  });

  it('is fresh when capsScrapedAt is recent', () => {
    expect(isCapsFresh(siteState({ capsScrapedAt: isoHoursAgo(1) }))).toBe(
      true,
    );
  });
});
