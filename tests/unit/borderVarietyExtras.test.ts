import { describe, expect, it } from 'vitest';

import {
  requiresExtraBorderVariety,
  type AchievementSnapshot,
} from '../../src/achievements/scraper';

function snapshotWith(
  items: AchievementSnapshot['items'],
): AchievementSnapshot {
  return {
    scrapedAt: new Date().toISOString(),
    username: 'tester',
    earnedCount: Object.values(items).filter((item) => item.isEarned).length,
    totalCount: Object.keys(items).length,
    items,
  };
}

describe('requiresExtraBorderVariety', () => {
  it('stops extras once Use 25 is earned even if lower tiers stay unearned', () => {
    expect(
      requiresExtraBorderVariety(
        snapshotWith({
          'try-it-on': {
            id: 'try-it-on',
            title: 'Try it on',
            isEarned: false,
          },
          'use-5-different-borders': {
            id: 'use-5-different-borders',
            title: 'Use 5 different borders',
            isEarned: false,
          },
          'use-25-different-borders': {
            id: 'use-25-different-borders',
            title: 'Use 25 different borders',
            isEarned: true,
          },
        }),
      ),
    ).toBe(false);
  });

  it('still extras while Use 25 is explicitly unearned', () => {
    expect(
      requiresExtraBorderVariety(
        snapshotWith({
          'use-10-different-borders': {
            id: 'use-10-different-borders',
            title: 'Use 10 different borders',
            isEarned: true,
          },
          'use-25-different-borders': {
            id: 'use-25-different-borders',
            title: 'Use 25 different borders',
            isEarned: false,
          },
        }),
      ),
    ).toBe(true);
  });

  it('does not extras for first-border when any use-N tier is earned', () => {
    expect(
      requiresExtraBorderVariety(
        snapshotWith({
          'add-your-first-border': {
            id: 'add-your-first-border',
            title: 'Add your first border',
            isEarned: false,
          },
          'use-5-different-borders': {
            id: 'use-5-different-borders',
            title: 'Use 5 different borders',
            isEarned: true,
          },
        }),
      ),
    ).toBe(false);
  });
});
