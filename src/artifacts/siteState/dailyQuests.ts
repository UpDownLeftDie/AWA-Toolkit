import { findActivityCard } from './shared';
import type { CapStatus, SiteState } from './types';

export type DailyQuestKind = 'daily' | 'weekend';

export interface DailyQuestRow {
  name: string;
  href?: string;
  status: 'complete' | 'incomplete';
  kind: DailyQuestKind;
}

export interface DailyQuestsState {
  scrapedAt: string;
  quests: DailyQuestRow[];
}

const DAILY_QUEST_STATUS_SELECTORS = [
  '[id^="control-center__daily-quest-status-"]',
  '[id^="control-center__daily-quests-status-"]',
  '[id^="control-center__weekend-quest-status-"]',
  '[id^="control-center__quest-status-"]',
] as const;

const HEADER_NAME = /^(incomplete|complete|status|game|quest|quests|reward|arp)$/i;

function dailyQuestStatusFromText(
  text: string,
): DailyQuestRow['status'] | undefined {
  const trimmed = text.trim();
  if (/^complete$/i.test(trimmed)) {
    return 'complete';
  }
  if (/^incomplete$/i.test(trimmed)) {
    return 'incomplete';
  }
  return undefined;
}

function dailyQuestKind(name: string, href?: string): DailyQuestKind {
  return /weekend/i.test(`${name} ${href ?? ''}`) ? 'weekend' : 'daily';
}

function pathnameFromHref(href: string | undefined): string | undefined {
  if (!href) {
    return undefined;
  }
  try {
    return new URL(href, 'https://na.alienwarearena.com').pathname;
  } catch {
    return href.startsWith('/') ? href : undefined;
  }
}

function questNameFromRow(row: Element): string | undefined {
  const questLink = [...row.querySelectorAll('a')].find((link) => {
    const href = link.getAttribute('href') ?? '';
    return /\/quests\//i.test(href) && !/\/steam\/quests\//i.test(href);
  });
  const raw =
    questLink?.textContent ??
    row.querySelector('a')?.textContent ??
    [...row.querySelectorAll('td')].find((cell) => {
      const text = cell.textContent?.replaceAll(/\s+/g, ' ').trim() ?? '';
      return text.length > 0 && !dailyQuestStatusFromText(text);
    })?.textContent;
  const name = raw?.replaceAll(/\s+/g, ' ').trim();
  if (!name || HEADER_NAME.test(name)) {
    return undefined;
  }
  return name;
}

function statusTextFromRow(row: Element): string {
  const fromCell = [...row.querySelectorAll('td, th, span, div')].find((cell) =>
    dailyQuestStatusFromText(cell.textContent ?? ''),
  );
  return fromCell?.textContent?.trim() ?? '';
}

function buildDailyQuestRow(
  row: Element,
  statusText: string,
): DailyQuestRow | undefined {
  const name = questNameFromRow(row);
  const status = dailyQuestStatusFromText(statusText);
  if (!name || !status) {
    return undefined;
  }
  const questLink = row.querySelector('a');
  const href = pathnameFromHref(questLink?.getAttribute('href') ?? undefined);
  const parsed: DailyQuestRow = {
    name,
    status,
    kind: dailyQuestKind(name, href),
  };
  if (href) {
    parsed.href = href;
  }
  return parsed;
}

function parseDailyQuestRowFromStatusCell(
  statusCell: Element,
): DailyQuestRow | undefined {
  const row = statusCell.closest('tr') ?? statusCell.parentElement;
  if (!row) {
    return undefined;
  }
  return buildDailyQuestRow(row, statusCell.textContent?.trim() ?? '');
}

function parseDailyQuestRowFromTableRow(row: Element): DailyQuestRow | undefined {
  return buildDailyQuestRow(row, statusTextFromRow(row));
}

export function scrapeDailyQuestRowsFromDocument(
  document_: Document,
): DailyQuestRow[] {
  const card = findActivityCard(document_, /^Daily Quests$/i);
  if (!card) {
    return [];
  }
  const fromStatusIds: DailyQuestRow[] = [];
  for (const selector of DAILY_QUEST_STATUS_SELECTORS) {
    fromStatusIds.push(
      ...[...card.querySelectorAll(selector)]
        .map((cell) => parseDailyQuestRowFromStatusCell(cell))
        .filter((row): row is DailyQuestRow => row !== undefined),
    );
  }
  if (fromStatusIds.length > 0) {
    return fromStatusIds;
  }
  const tableRows = [...card.querySelectorAll('tr')]
    .map((row) => parseDailyQuestRowFromTableRow(row))
    .filter((row): row is DailyQuestRow => row !== undefined);
  if (tableRows.length > 0) {
    return tableRows;
  }
  return [...card.querySelectorAll('li')]
    .map((row) => parseDailyQuestRowFromTableRow(row))
    .filter((row): row is DailyQuestRow => row !== undefined);
}

export function dailyQuestsCapFromRows(
  quests: DailyQuestRow[],
): CapStatus | undefined {
  if (quests.length === 0) {
    return undefined;
  }
  return remainingDailyQuestRowsFromList(quests).length > 0
    ? 'available'
    : 'capped';
}

function remainingDailyQuestRowsFromList(
  quests: DailyQuestRow[],
): DailyQuestRow[] {
  return quests.filter((quest) => quest.status === 'incomplete');
}

export function remainingDailyQuestRows(siteState: SiteState): DailyQuestRow[] {
  return remainingDailyQuestRowsFromList(siteState.dailyQuests?.quests ?? []);
}

export function applyDailyQuestsFromDocument(
  next: SiteState,
  document_: Document,
): void {
  const scraped = scrapeDailyQuestRowsFromDocument(document_);
  if (scraped.length === 0) {
    return;
  }
  next.dailyQuests = {
    scrapedAt: new Date().toISOString(),
    quests: scraped,
  };
  const cap = dailyQuestsCapFromRows(scraped);
  if (cap) {
    next.caps.dailyQuests = cap;
  }
}
