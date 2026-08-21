import { describe, expect, it } from 'vitest';

import { hasVotedCurrentDiscordPoll } from '../../src/artifacts/siteState/caps';
import type { ArpLogState } from '../../src/artifacts/siteState/arpLog';

function log(recent: ArpLogState['recent']): ArpLogState {
  return { scrapedAt: '2026-08-20T17:00:00.000Z', recent };
}

describe('hasVotedCurrentDiscordPoll', () => {
  // Thursday 17:00 UTC — today's poll posted at 16:00; previous was Wed 16:00.
  const afterThursdayPost = new Date('2026-08-20T17:00:00.000Z');
  // Thursday 12:00 UTC — still on Wednesday's poll.
  const beforeThursdayPost = new Date('2026-08-20T12:00:00.000Z');

  it('treats a day-boundary Discord Poll as a late previous-poll vote after the new post', () => {
    const arpLog = log([
      { action: 'Time On Site', arp: 10, date: '2026-08-20' },
      { action: 'Discord Poll', arp: 5, date: '2026-08-20' },
      { action: 'Watch Twitch', arp: 15, date: '2026-08-19' },
      { action: 'Daily Login Calendar', arp: 5, date: '2026-08-19' },
    ]);
    expect(hasVotedCurrentDiscordPoll(arpLog, afterThursdayPost)).toBe(false);
  });

  it('still counts that late stamp against the previous poll before the new post', () => {
    const arpLog = log([
      { action: 'Discord Poll', arp: 5, date: '2026-08-20' },
      { action: 'Watch Twitch', arp: 15, date: '2026-08-19' },
    ]);
    expect(hasVotedCurrentDiscordPoll(arpLog, beforeThursdayPost)).toBe(true);
  });

  it('counts a same-day poll vote that sits above other same-day activity', () => {
    const arpLog = log([
      { action: 'Discord Poll', arp: 5, date: '2026-08-20' },
      { action: 'Time On Site', arp: 10, date: '2026-08-20' },
      { action: 'Daily Login Calendar', arp: 5, date: '2026-08-20' },
      { action: 'Watch Twitch', arp: 15, date: '2026-08-19' },
    ]);
    expect(hasVotedCurrentDiscordPoll(arpLog, afterThursdayPost)).toBe(true);
  });

  it('counts today when the previous cycle already has its own Discord Poll row', () => {
    const arpLog = log([
      { action: 'Time On Site', arp: 10, date: '2026-08-20' },
      { action: 'Discord Poll', arp: 5, date: '2026-08-20' },
      { action: 'Watch Twitch', arp: 15, date: '2026-08-19' },
      { action: 'Discord Poll', arp: 5, date: '2026-08-19' },
    ]);
    expect(hasVotedCurrentDiscordPoll(arpLog, afterThursdayPost)).toBe(true);
  });

  it('keeps Friday votes covering the weekend', () => {
    const saturday = new Date('2026-08-22T12:00:00.000Z');
    const arpLog = log([
      { action: 'Discord Poll', arp: 5, date: '2026-08-21' },
      { action: 'Time On Site', arp: 10, date: '2026-08-21' },
    ]);
    expect(hasVotedCurrentDiscordPoll(arpLog, saturday)).toBe(true);
  });
});
