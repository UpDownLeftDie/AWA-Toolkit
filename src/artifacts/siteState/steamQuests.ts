import { BASE_ACTIVITY } from '../data';
import { scrapeSteamAppIdFromDocument } from '../steamApp';
import { controlLabel, findActivityCard, pageText } from './shared';
import type { CapStatus, SiteState } from './types';

export type SteamPlayEligibility = 'eligible' | 'ineligible' | 'unknown';

export interface SteamQuestRow {
  id?: string;
  name: string;
  href?: string;
  rewardArp: number;
  status: 'complete' | 'incomplete';
  /**
  Steam Quests require owning the game (family sharing doesn't count).
  Choose Your Own Game is always eligible. Paid titles stay `unknown` until
  the quest page is scraped; Check Game + a paid Steam listing → ineligible.
  Check Game + Steam `is_free` (or $0) stays eligible (`libraryPending`).
  */
  eligibility: SteamPlayEligibility;
  steamAppId?: number;
  isFree?: boolean;
  libraryPending?: boolean;
}

export interface SteamQuestsState {
  scrapedAt: string;
  quests: SteamQuestRow[];
}

const STEAM_QUEST_STATUS_ID_PREFIX = 'control-center__steam-quest-status-';
const STEAM_LIBRARY_SYNC_LABEL = /^(Check Game|Visit Steam|Sync Games)$/i;
const STEAM_OWNERSHIP_DENIAL =
  /do not own|don['’]t own|not in your steam library|not in your library|must own this game/i;

function hasSteamLibrarySyncControl(document_: Document): boolean {
  if (document_.querySelector('.btn-check-owned-games')) {
    return true;
  }
  return [...document_.querySelectorAll('a, button')].some((element) =>
    STEAM_LIBRARY_SYNC_LABEL.test(controlLabel(element)),
  );
}

function hasSteamOwnershipDenialText(document_: Document): boolean {
  return STEAM_OWNERSHIP_DENIAL.test(pageText(document_));
}

export function isChooseYourOwnGameQuest(quest: {
  name: string;
  href?: string;
}): boolean {
  return /choose[- ]your[- ]own[- ]game/i.test(
    `${quest.name} ${quest.href ?? ''}`,
  );
}

function steamQuestStatusFromText(
  text: string,
): SteamQuestRow['status'] | undefined {
  const trimmed = text.trim();
  if (/^complete$/i.test(trimmed)) {
    return 'complete';
  }
  if (/^incomplete$/i.test(trimmed)) {
    return 'incomplete';
  }
  return undefined;
}

function steamQuestEligibilityFromStatusText(
  text: string,
  quest: { name: string; href?: string },
): SteamPlayEligibility {
  if (/unavailable|ineligible|locked|not owned|unowned/i.test(text.trim())) {
    return 'ineligible';
  }
  if (isChooseYourOwnGameQuest(quest)) {
    return 'eligible';
  }
  return 'unknown';
}

function parseSteamQuestRewardArp(text: string): number | undefined {
  const compact = text.replaceAll(',', '');
  const arpAt = compact.toUpperCase().indexOf(' ARP');
  if (arpAt === -1) {
    return undefined;
  }
  const amountToken = compact.slice(0, arpAt).trim().split(' ').at(-1);
  const reward = Number(amountToken);
  return Number.isFinite(reward) && reward > 0 ? reward : undefined;
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

function buildSteamQuestRow(options: {
  id?: string;
  name: string;
  href?: string;
  rewardArp: number;
  statusText: string;
}): SteamQuestRow {
  const { name, href, rewardArp, statusText, id } = options;
  const identity = { name, ...(href && { href }) };
  const status = steamQuestStatusFromText(statusText) ?? 'incomplete';
  const row: SteamQuestRow = {
    name,
    rewardArp,
    status,
    eligibility:
      status === 'complete'
        ? 'eligible'
        : steamQuestEligibilityFromStatusText(statusText, identity),
  };
  if (id) {
    row.id = id;
  }
  if (href) {
    row.href = href;
  }
  return row;
}

function parseSteamQuestRowFromStatusCell(
  card: Element,
  statusCell: Element,
): SteamQuestRow | undefined {
  const id = statusCell.id.startsWith(STEAM_QUEST_STATUS_ID_PREFIX)
    ? statusCell.id.slice(STEAM_QUEST_STATUS_ID_PREFIX.length)
    : undefined;
  const row = statusCell.closest('tr') ?? statusCell.parentElement;
  if (!row) {
    return undefined;
  }
  const questLink = row.querySelector('a[href*="/steam/quests/"]');
  const name =
    questLink?.textContent?.replaceAll(/\s+/g, ' ').trim() ||
    row.querySelector('a')?.textContent?.replaceAll(/\s+/g, ' ').trim();
  if (!name) {
    return undefined;
  }
  const rewardCell = id
    ? card.querySelector(`#control-center__steam-quest-reward-${id}`)
    : undefined;
  const rewardArp = parseSteamQuestRewardArp(
    rewardCell?.textContent ?? row.textContent ?? '',
  );
  if (rewardArp === undefined) {
    return undefined;
  }
  const href = pathnameFromHref(questLink?.getAttribute('href') ?? undefined);
  return buildSteamQuestRow({
    name,
    rewardArp,
    statusText: statusCell.textContent?.trim() ?? '',
    ...(id && { id }),
    ...(href && { href }),
  });
}

function parseSteamQuestRowFromTableRow(
  row: Element,
): SteamQuestRow | undefined {
  const questLink = row.querySelector('a[href*="/steam/quests/"]');
  const name = questLink?.textContent?.replaceAll(/\s+/g, ' ').trim();
  if (!name) {
    return undefined;
  }
  const rewardArp = parseSteamQuestRewardArp(row.textContent ?? '');
  if (rewardArp === undefined) {
    return undefined;
  }
  const statusCell = [...row.querySelectorAll('td')].find((cell) =>
    steamQuestStatusFromText(cell.textContent ?? ''),
  );
  const href = pathnameFromHref(questLink?.getAttribute('href') ?? undefined);
  return buildSteamQuestRow({
    name,
    rewardArp,
    statusText: statusCell?.textContent?.trim() ?? '',
    ...(href && { href }),
  });
}

export function scrapeSteamQuestRowsFromDocument(
  document_: Document,
): SteamQuestRow[] {
  const card = findActivityCard(document_, /^Steam Quests$/i);
  if (!card) {
    return [];
  }
  const fromStatusIds = [
    ...card.querySelectorAll('[id^="control-center__steam-quest-status-"]'),
  ]
    .map((cell) => parseSteamQuestRowFromStatusCell(card, cell))
    .filter((row): row is SteamQuestRow => row !== undefined);
  if (fromStatusIds.length > 0) {
    return fromStatusIds;
  }
  return [...card.querySelectorAll('tr')]
    .map((row) => parseSteamQuestRowFromTableRow(row))
    .filter((row): row is SteamQuestRow => row !== undefined);
}

export function steamQuestsCapFromRows(
  quests: SteamQuestRow[],
): CapStatus | undefined {
  if (quests.length === 0) {
    return undefined;
  }
  return remainingSteamQuestRowsFromList(quests).length > 0
    ? 'available'
    : 'capped';
}

function steamQuestRowKey(row: SteamQuestRow): string {
  return row.id ?? row.href ?? row.name.toLowerCase();
}

function mergeSteamQuestRows(
  scraped: SteamQuestRow[],
  previous: SteamQuestRow[] | undefined,
): SteamQuestRow[] {
  if (!previous || previous.length === 0) {
    return scraped;
  }
  const priorByKey = new Map(
    previous.map((row) => [steamQuestRowKey(row), row]),
  );
  return scraped.map((row) => {
    const prior = priorByKey.get(steamQuestRowKey(row));
    if (!prior) {
      return row;
    }
    if (row.eligibility !== 'unknown' || prior.status !== row.status) {
      return row;
    }
    const merged: SteamQuestRow = {
      ...row,
      eligibility: prior.eligibility,
    };
    if (prior.steamAppId !== undefined) {
      merged.steamAppId = prior.steamAppId;
    }
    if (prior.isFree !== undefined) {
      merged.isFree = prior.isFree;
    }
    if (prior.libraryPending === true) {
      merged.libraryPending = true;
    }
    return merged;
  });
}

function remainingSteamQuestRowsFromList(
  quests: SteamQuestRow[],
): SteamQuestRow[] {
  return quests.filter(
    (quest) =>
      quest.status === 'incomplete' && quest.eligibility !== 'ineligible',
  );
}

export function remainingSteamQuestRows(siteState: SiteState): SteamQuestRow[] {
  return remainingSteamQuestRowsFromList(siteState.steamQuests?.quests ?? []);
}

/**
 * Bases still earnable this week. Falls back to the typical 15+25+25 week
 * when Control Center rows haven't been scraped yet. Upcoming weeks are
 * unknown until posted — monthly META still uses the typical week.
 */
export function remainingSteamQuestRewards(siteState: SiteState): number[] {
  const scraped = scrapedRemainingSteamQuestRewards(siteState);
  if (scraped !== undefined) {
    return scraped;
  }
  return [...BASE_ACTIVITY.steamQuestBases];
}

/**
 * Remaining Steam Quest bases from Control Center rows. `undefined` when
 * rows have not been scraped — do not invent a 15+25+25 week for 24h scoring.
 */
export function scrapedRemainingSteamQuestRewards(
  siteState: SiteState,
): number[] | undefined {
  const quests = siteState.steamQuests?.quests;
  if (!quests || quests.length === 0) {
    return undefined;
  }
  return remainingSteamQuestRowsFromList(quests).map(
    (quest) => quest.rewardArp,
  );
}

export function requiresSteamQuestEligibilityFetch(state: SiteState): boolean {
  return (state.steamQuests?.quests ?? []).some((quest) => {
    if (
      quest.status !== 'incomplete' ||
      !quest.href ||
      isChooseYourOwnGameQuest(quest)
    ) {
      return false;
    }
    if (quest.eligibility === 'unknown') {
      return true;
    }
    return quest.eligibility === 'ineligible' && quest.isFree === undefined;
  });
}

/**
 * Quest/event page signals that the linked Steam account does not own the
 * game. Buttons exist in the DOM only when AWA failed the library check;
 * completed/in-progress pages keep the click handlers in a script tag.
 */
export function scrapeSteamPlayEligibilityFromDocument(
  document_: Document,
  options: { personalHours?: number; href?: string } = {},
): SteamPlayEligibility {
  if ((options.personalHours ?? 0) > 0) {
    return 'eligible';
  }
  if (
    options.href &&
    isChooseYourOwnGameQuest({ name: '', href: options.href })
  ) {
    return 'eligible';
  }
  const body = pageText(document_);
  if (/completed this quest/i.test(body)) {
    return 'eligible';
  }
  if (document_.querySelector('.btn-start-quest, a[href^="steam://"]')) {
    return 'eligible';
  }
  const hasLaunchGame = [...document_.querySelectorAll('a, button')].some(
    (element) => /^Launch Game$/i.test(controlLabel(element)),
  );
  if (hasLaunchGame) {
    return 'eligible';
  }
  const progress = document_.querySelector(
    ':scope .progress-steam-quest [aria-valuenow]',
  );
  const played = Number(progress?.getAttribute('aria-valuenow') ?? '');
  if (Number.isFinite(played) && played > 0) {
    return 'eligible';
  }
  if (
    hasSteamLibrarySyncControl(document_) ||
    hasSteamOwnershipDenialText(document_)
  ) {
    return 'ineligible';
  }
  return 'unknown';
}

export function applySteamQuestsFromDocument(
  next: SiteState,
  document_: Document,
): void {
  const scraped = scrapeSteamQuestRowsFromDocument(document_);
  if (scraped.length === 0) {
    return;
  }
  const quests = mergeSteamQuestRows(scraped, next.steamQuests?.quests);
  next.steamQuests = {
    scrapedAt: new Date().toISOString(),
    quests,
  };
  const cap = steamQuestsCapFromRows(quests);
  if (cap) {
    next.caps.steamQuests = cap;
  }
}

export function applySteamQuestDetailFromDocument(
  next: SiteState,
  document_: Document,
  pagePath: string,
): void {
  const quests = [...(next.steamQuests?.quests ?? [])];
  if (quests.length === 0) {
    return;
  }
  const index = quests.findIndex(
    (quest) => quest.href && pagePath.includes(quest.href),
  );
  if (index === -1) {
    return;
  }
  const current = quests[index];
  if (!current) {
    return;
  }
  const isQuestComplete = /completed this quest/i.test(pageText(document_));
  const scrapedEligibility = scrapeSteamPlayEligibilityFromDocument(
    document_,
    current.href ? { href: current.href } : {},
  );
  let eligibility = scrapedEligibility;
  if (isQuestComplete) {
    eligibility = 'eligible';
  } else if (scrapedEligibility === 'unknown') {
    eligibility = current.eligibility;
  }
  const steamAppId =
    scrapeSteamAppIdFromDocument(document_) ?? current.steamAppId;
  const updated: SteamQuestRow = {
    ...current,
    eligibility,
    status: isQuestComplete ? 'complete' : current.status,
  };
  if (steamAppId !== undefined) {
    updated.steamAppId = steamAppId;
  }
  quests[index] = updated;
  next.steamQuests = {
    scrapedAt: new Date().toISOString(),
    quests,
  };
  const cap = steamQuestsCapFromRows(quests);
  if (cap) {
    next.caps.steamQuests = cap;
  }
}
