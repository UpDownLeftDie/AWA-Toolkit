import { describe, expect, it } from 'vitest';

import {
  isAchievementsDocumentReady,
  scrapeAchievementsFromDocument,
} from '../../src/achievements/scraper';

function mockAchievementsDocument(bodyText: string): Document {
  return {
    body: { textContent: bodyText },
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
  } as unknown as Document;
}

const SAMPLE_PAGE = `
MOST RECENT ACHIEVEMENTS
Visit the FAQ page
---
Your Reward:
Post a relay
---
Your Reward:
70/121 ACHIEVEMENTS
Profile
Add about me
---
Your Reward:
Try it on
Not Earned Yet
---
Your Reward:
Visit the Hive page
---
Your Reward:
`;

describe('achievements scraper', () => {
  it('reads earned/total counts from AWA achievements header', () => {
    const document_ = mockAchievementsDocument(SAMPLE_PAGE);
    const snapshot = scrapeAchievementsFromDocument(document_, {
      username: 'CamKitties',
    });
    expect(snapshot.earnedCount).toBe(70);
    expect(snapshot.totalCount).toBe(121);
  });

  it('marks achievements without Not Earned Yet as earned', () => {
    const document_ = mockAchievementsDocument(SAMPLE_PAGE);
    const snapshot = scrapeAchievementsFromDocument(document_, {
      username: 'CamKitties',
    });
    expect(snapshot.items['visit-the-faq-page']?.isEarned).toBe(true);
    expect(snapshot.items['visit-the-hive-page']?.isEarned).toBe(true);
    expect(snapshot.items['post-a-relay']?.isEarned).toBe(true);
  });

  it('marks achievements with Not Earned Yet in their segment as unearned', () => {
    const document_ = mockAchievementsDocument(SAMPLE_PAGE);
    const snapshot = scrapeAchievementsFromDocument(document_, {
      username: 'CamKitties',
    });
    expect(snapshot.items['try-it-on']?.isEarned).toBe(false);
  });

  it('ignores most recent achievements heading when parsing count', () => {
    const document_ = mockAchievementsDocument(`
MOST RECENT ACHIEVEMENTS
Visit the FAQ page
70/121 ACHIEVEMENTS
`);
    const snapshot = scrapeAchievementsFromDocument(document_, {
      username: 'CamKitties',
    });
    expect(snapshot.earnedCount).toBe(70);
    expect(snapshot.totalCount).toBe(121);
  });

  it('detects when achievements content has loaded', () => {
    expect(isAchievementsDocumentReady(mockAchievementsDocument(''))).toBe(
      false,
    );
    expect(
      isAchievementsDocumentReady(mockAchievementsDocument(SAMPLE_PAGE)),
    ).toBe(true);
  });
});
