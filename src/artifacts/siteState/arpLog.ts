import { pageText } from './shared';
import type { SiteState } from './types';

export interface ArpLogEntry {
  action: string;
  arp: number;
  date?: string;
}

export interface ArpLogState {
  scrapedAt: string;
  redeemableArp?: number;
  lifetimeArp?: number;
  /**
	Today's ARP delta shown next to redeemable balance on the log page.
	*/
  todayDelta?: number;
  recent: ArpLogEntry[];
}

function parseRedeemableArpText(text: string): number | undefined {
  const match = /Redeemable ARP:\s*([\d,]+)/i.exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(value) ? value : undefined;
}

export function scrapeRedeemableArpFromDocument(
  document_: Document,
): number | undefined {
  if (document_ === document) {
    const win = globalThis as typeof globalThis & {
      user_arp?: unknown;
      arp_points?: unknown;
      redeemable_arp?: unknown;
    };
    for (const value of [win.user_arp, win.arp_points, win.redeemable_arp]) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
  }
  for (const script of document_.querySelectorAll('script')) {
    const match =
      /(?:var\s+|window\.)?(?:user_arp|arp_points|redeemable_arp)\s*=\s*(\d+)/.exec(
        script.textContent ?? '',
      );
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return parseRedeemableArpText(pageText(document_));
}

export function applyRedeemableArpFromDocument(
  next: SiteState,
  document_: Document,
): void {
  const arp = scrapeRedeemableArpFromDocument(document_);
  if (arp === undefined) {
    return;
  }
  next.arpLog = {
    scrapedAt: next.arpLog?.scrapedAt ?? new Date().toISOString(),
    recent: next.arpLog?.recent ?? [],
    ...next.arpLog,
    redeemableArp: arp,
  };
}

/**
 * Best-effort ARP Log scrape (action rows + balance header).
 */
export function scrapeArpLogFromDocument(document_: Document): ArpLogState {
  const body = pageText(document_);
  const state: ArpLogState = {
    scrapedAt: new Date().toISOString(),
    recent: [],
  };

  const redeemableArp = parseRedeemableArpText(body);
  if (redeemableArp !== undefined) {
    state.redeemableArp = redeemableArp;
  }
  const lifetime = /Lifetime ARP:\s*([\d,]+)/i.exec(body);
  if (lifetime?.[1]) {
    state.lifetimeArp = Number(lifetime[1].replaceAll(',', ''));
  }

  const todayTotal = /Total ARP earned today:\s*([\d,]+)/i.exec(body);
  if (todayTotal?.[1]) {
    state.todayDelta = Number(todayTotal[1].replaceAll(',', ''));
  } else {
    // ARP Log header shows redeemable with a sibling +N for the filtered window.
    const plusMatch = /Redeemable ARP:[\s\S]{0,80}?\+\s*([\d,]+)/i.exec(body);
    if (plusMatch?.[1]) {
      state.todayDelta = Number(plusMatch[1].replaceAll(',', ''));
    }
  }

  const actionNames = [
    'Time On Site',
    'Game Prize',
    'Daily Login Calendar',
    'Daily Login Streak',
    'Discord Poll',
    'Steam Community Event Reward',
    'Steam Quest',
    'Steam Quests',
    'Twitch Passive',
    'Watch Twitch',
    'Community Event',
    'Forum Post',
    'Giveaway',
    'Battle Pass Reward',
    'Battle Pass',
    'Quest',
  ].join('|');
  const rowPattern = new RegExp(
    String.raw`(${actionNames})\s+(\d+)\s+(\d{4}-\d{2}-\d{2})`,
    'gi',
  );
  for (const match of body.matchAll(rowPattern)) {
    const entry: ArpLogEntry = {
      action: match[1] ?? 'Unknown',
      arp: Number(match[2]),
    };
    if (match[3]) {
      entry.date = match[3];
    }
    state.recent.push(entry);
  }

  return state;
}

/**
 * Merge a fresh ARP Log scrape with whatever's cached.
 *
 * The background fetch requests an explicit `from`/`to` window, but a user
 * browsing to `/arp-log` themselves gets the page's unfiltered default view,
 * which only lists the 10 most recent rows. Replacing the cached (wider)
 * `recent` with that would throw away days of history the background fetch
 * already captured. Entries have no stable id, so rows are deduped on
 * (date, action, arp) — the same identity a repeat scrape of the same
 * underlying row would produce.
 */
export function mergeArpLogScrape(
  scraped: ArpLogState,
  previous: ArpLogState | undefined,
): ArpLogState {
  if (!previous) {
    return scraped;
  }
  const seen = new Set<string>();
  const recent: ArpLogEntry[] = [];
  for (const entry of [...scraped.recent, ...previous.recent]) {
    const key = `${entry.date ?? ''}|${entry.action}|${entry.arp}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    recent.push(entry);
  }
  recent.sort((left, right) =>
    (right.date ?? '').localeCompare(left.date ?? ''),
  );
  const redeemableArp = scraped.redeemableArp ?? previous.redeemableArp;
  const lifetimeArp = scraped.lifetimeArp ?? previous.lifetimeArp;
  const todayDelta = scraped.todayDelta ?? previous.todayDelta;
  return {
    scrapedAt: scraped.scrapedAt,
    ...(redeemableArp !== undefined && { redeemableArp }),
    ...(lifetimeArp !== undefined && { lifetimeArp }),
    ...(todayDelta !== undefined && { todayDelta }),
    recent,
  };
}
