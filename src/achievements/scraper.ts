import { GM } from '$';
import { showAoToast } from '../artifacts/ui/dialog';
import { documentBody, readPageUsername } from '../pageGlobals';
import {
  ACHIEVEMENTS,
  FAQ_PATH,
  GAME_VAULT_PATH,
  HIVE_PATH,
  matchAchievementInText,
  NEWS_PATH,
  VIDEOS_PATH,
  type AchievementAutomationKey,
  type AchievementDefinition,
} from './data';
import {
  getAchievementSettings,
  isAchievementAutomationEnabled,
  loadAutomationCooldowns,
  saveAutomationCooldowns,
  utcDateString,
  utcMonthString,
  type AchievementSettings,
} from './settings';

const SNAPSHOT_KEY = 'achievementSnapshot';
/**
How long a good scrape stays fresh before background hydrate re-fetches.
Same ballpark as inventory / caps (6h); Refresh still force-fetches anytime.
*/
export const ACHIEVEMENT_STALE_MS = 6 * 60 * 60 * 1000;
const FORCE_REFRESH_COOLDOWN_MS = 5 * 1000;
const IFRAME_TIMEOUT_MS = 8000;
const IFRAME_SETTLE_MS = 400;
const PERSONALIZATION_PATH = '/account/personalization';
const AUTOMATION_ARTICLE_LIMIT = 10;
const AUTOMATION_VIDEO_LIMIT = 10;
/*
Per-path ceiling for fetch + iframe fallback during automations.
*/
const AUTOMATION_VISIT_TIMEOUT_MS = 5000;
/*
Soft wall-clock budget for article/video visit batches.
*/
const AUTOMATION_BATCH_BUDGET_MS = 20_000;
const NOT_EARNED_PATTERN = /not earned yet/i;
const COUNT_MARKER = ' achievements';
const CARD_SELECTOR = [
  '.achievement-card',
  '.achievement',
  '.achievements-item',
  '.member-achievement',
  '.achievement-item',
].join(', ');

export interface AchievementProgress {
  id: string;
  title: string;
  isEarned: boolean;
}

export interface AchievementSnapshot {
  scrapedAt: string;
  username: string | undefined;
  earnedCount: number;
  totalCount: number;
  items: Record<string, AchievementProgress>;
}

interface AvatarSelection {
  avatar: number | undefined;
  background: number | undefined;
  border: number | undefined;
}

interface PersonalizationFormState {
  aboutAction: string;
  aboutToken: string;
  customTitle: string;
  aboutHtml: string;
  userId: number | undefined;
  selection: AvatarSelection;
  /**
  Gallery ids from `data-type="border"` on /account/personalization.
  */
  availableBorderIds: number[];
  /**
  Gallery ids from `data-type="avatar"`.
  */
  availableAvatarIds: number[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isAchievementsPage(path = location.pathname): boolean {
  return /\/member\/[^/]+\/achievements\/?$/i.test(path);
}

export function readUsernameFromDocument(
  document_: Document,
  pathHint?: string,
): string | undefined {
  const fromPage = document_ === document ? readPageUsername() : undefined;
  if (fromPage) {
    return fromPage;
  }
  const pathMatch = /\/member\/([^/]+)\//i.exec(pathHint ?? location.pathname);
  if (pathMatch?.[1]) {
    return decodeURIComponent(pathMatch[1]);
  }
  const link = document_.querySelector<HTMLAnchorElement>(
    'a[href*="/member/"][href$="/artifacts"], a[href*="/member/"][href$="/achievements"]',
  );
  const hrefMatch = /\/member\/([^/]+)\//i.exec(
    link?.getAttribute('href') ?? '',
  );
  return hrefMatch?.[1] ? decodeURIComponent(hrefMatch[1]) : undefined;
}

export function resolveAchievementsUrl(username?: string): string | undefined {
  // Prefer the live page username — GM snapshots keep the old name after a rename.
  let live: string | undefined;
  try {
    live = readUsernameFromDocument(document);
  } catch {
    // Unit tests / non-DOM contexts.
  }
  const name = live ?? username;
  return name ? `/member/${encodeURIComponent(name)}/achievements` : undefined;
}

function emptySnapshot(username: string | undefined): AchievementSnapshot {
  return {
    scrapedAt: new Date(0).toISOString(),
    username,
    earnedCount: 0,
    // Live total comes from the page header (e.g. 77/118). Do not pretend the
    // local catalog length is the site total before a scrape.
    totalCount: 0,
    items: {},
  };
}

function trailingNumber(value: string): number | undefined {
  let index = value.length - 1;
  while (index >= 0 && value.charAt(index) === ' ') {
    index -= 1;
  }
  const end = index;
  while (index >= 0) {
    const char = value.charAt(index);
    if (char < '0' || char > '9') {
      break;
    }
    index -= 1;
  }
  if (end === index) {
    return undefined;
  }
  const parsed = Number(value.slice(index + 1, end + 1));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function leadingNumber(value: string): number | undefined {
  let index = 0;
  while (index < value.length && value.charAt(index) === ' ') {
    index += 1;
  }
  const start = index;
  while (index < value.length) {
    const char = value.charAt(index);
    if (char < '0' || char > '9') {
      break;
    }
    index += 1;
  }
  if (start === index) {
    return undefined;
  }
  const parsed = Number(value.slice(start, index));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCountFromText(
  text: string,
): { earned: number; total: number } | undefined {
  const collapsed = text.replaceAll(/\s+/g, ' ').toLowerCase();
  let searchFrom = 0;
  while (searchFrom < collapsed.length) {
    const markerIndex = collapsed.indexOf(COUNT_MARKER, searchFrom);
    if (markerIndex === -1) {
      return undefined;
    }
    const window = collapsed.slice(Math.max(0, markerIndex - 24), markerIndex);
    const slashIndex = window.lastIndexOf('/');
    if (slashIndex !== -1) {
      const earned = trailingNumber(window.slice(0, slashIndex));
      const total = leadingNumber(window.slice(slashIndex + 1));
      if (earned !== undefined && total !== undefined) {
        return { earned, total };
      }
    }
    searchFrom = markerIndex + COUNT_MARKER.length;
  }
  return undefined;
}

function parseCount(
  document_: Document,
): { earned: number; total: number } | undefined {
  const fromBody = parseCountFromText(
    documentBody(document_)?.textContent ?? '',
  );
  if (fromBody) {
    return fromBody;
  }
  for (const element of document_.querySelectorAll(
    'h1, h2, h3, h4, h5, strong, span, div, p',
  )) {
    const text = element.textContent;
    const lowered = text.replaceAll(/\s+/g, ' ').toLowerCase();
    if (!lowered.includes('achievements') || !lowered.includes('/')) {
      continue;
    }
    const parsed = parseCountFromText(text);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

export function isAchievementsDocumentReady(
  document_: Document = document,
): boolean {
  return parseCount(document_) !== undefined;
}

export async function waitForAchievementsDocument(
  timeoutMs = 12_000,
): Promise<void> {
  if (isAchievementsDocumentReady(document)) {
    return;
  }
  await new Promise<void>((resolve) => {
    let isSettled = false;
    const observer = new MutationObserver(() => {
      if (isAchievementsDocumentReady(document)) {
        finish();
      }
    });
    const timer = setTimeout(finish, timeoutMs);
    function finish(): void {
      if (isSettled) {
        return;
      }
      isSettled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });
}

function isEarnedCardText(text: string): boolean {
  return !NOT_EARNED_PATTERN.test(text);
}

function achievementNames(definition: AchievementDefinition): string[] {
  return [definition.title, ...(definition.aliases ?? [])];
}

function segmentForAchievement(
  collapsed: string,
  achievement: AchievementDefinition,
): string | undefined {
  const haystack = collapsed.toLowerCase();
  let start = -1;
  let matchedLength = 0;
  for (const name of achievementNames(achievement)) {
    const index = haystack.indexOf(name.toLowerCase());
    if (index === -1) {
      continue;
    }
    if (!(start === -1 || index < start)) {
      continue;
    }

    start = index;
    matchedLength = name.length;
  }
  if (start === -1) {
    return undefined;
  }
  let end = collapsed.length;
  for (const other of ACHIEVEMENTS) {
    if (other.id === achievement.id) {
      continue;
    }
    for (const name of achievementNames(other)) {
      const index = haystack.indexOf(name.toLowerCase(), start + matchedLength);
      if (index !== -1 && index < end) {
        end = index;
      }
    }
  }
  return collapsed.slice(start, end);
}

function recordProgress(
  items: Record<string, AchievementProgress>,
  definition: AchievementDefinition,
  isEarned: boolean,
): void {
  const existing = items[definition.id];
  if (existing?.isEarned === true) {
    return;
  }
  items[definition.id] = {
    id: definition.id,
    title: definition.title,
    isEarned,
  };
}

function isCardUnearned(card: Element): boolean {
  return (
    card.classList.contains('unachieved') ||
    (!card.classList.contains('achieved') &&
      !isEarnedCardText(card.textContent))
  );
}

function scrapeFromCards(
  document_: Document,
  items: Record<string, AchievementProgress>,
): number {
  // Prefer leaf cards — parent rows match too many class substrings and mix
  // earned/unearned text into one blob.
  const preferred = document_.querySelectorAll('.achievement-card');
  const nodes =
    preferred.length > 0
      ? preferred
      : document_.querySelectorAll(CARD_SELECTOR);
  for (const card of nodes) {
    const nestedCards = card.querySelectorAll('.achievement-card');
    // Skip wrappers that contain multiple child cards
    if (nestedCards.length > 1) {
      continue;
    }
    const text = card.textContent;
    const definition = matchAchievementInText(text);
    if (!definition) {
      continue;
    }
    recordProgress(items, definition, !isCardUnearned(card));
  }
  return nodes.length;
}

function scrapeFromAchievementSegments(
  document_: Document,
  items: Record<string, AchievementProgress>,
): void {
  const collapsed = (documentBody(document_)?.textContent ?? '').replaceAll(
    /\s+/g,
    ' ',
  );
  for (const achievement of ACHIEVEMENTS) {
    // Cards win — do not let body segments overwrite a card match
    if (items[achievement.id] !== undefined) {
      continue;
    }
    const segment = segmentForAchievement(collapsed, achievement);
    if (segment === undefined) {
      continue;
    }
    recordProgress(items, achievement, isEarnedCardText(segment));
  }
}

function isEarnedFromCollapsedText(
  collapsed: string,
  achievement: AchievementDefinition,
): boolean | undefined {
  const segment = segmentForAchievement(collapsed, achievement);
  return segment === undefined ? undefined : isEarnedCardText(segment);
}

function scrapeFromBodyText(
  document_: Document,
  items: Record<string, AchievementProgress>,
): void {
  const collapsed = (documentBody(document_)?.textContent ?? '').replaceAll(
    /\s+/g,
    ' ',
  );
  for (const achievement of ACHIEVEMENTS) {
    if (items[achievement.id] !== undefined) {
      continue;
    }
    const isEarned = isEarnedFromCollapsedText(collapsed, achievement);
    if (isEarned === undefined) {
      continue;
    }
    recordProgress(items, achievement, isEarned);
  }
}

function scrapeOptions(options: {
  username?: string | undefined;
  pathHint?: string | undefined;
}): { username?: string; pathHint?: string } {
  const result: { username?: string; pathHint?: string } = {};
  if (options.username !== undefined) {
    result.username = options.username;
  }
  if (options.pathHint !== undefined) {
    result.pathHint = options.pathHint;
  }
  return result;
}

/**
When a higher rank in a chain is earned, lower ranks are done too (AWA stacks
often leave "Try it on" looking unearned after Use 25). Also: any border-use
implies first-border.
*/
export function inferImpliedGroupEarnings(
  items: Record<string, AchievementProgress>,
): Record<string, AchievementProgress> {
  const next: Record<string, AchievementProgress> = { ...items };
  const groups = new Set(ACHIEVEMENTS.map((achievement) => achievement.group));
  for (const group of groups) {
    const chain = ACHIEVEMENTS.filter(
      (achievement) => achievement.group === group,
    );
    const maxEarnedRank = Math.max(
      0,
      ...chain
        .filter((achievement) => next[achievement.id]?.isEarned === true)
        .map((achievement) => achievement.rank),
    );
    if (maxEarnedRank <= 0) {
      continue;
    }
    for (const achievement of chain) {
      if (achievement.rank >= maxEarnedRank) {
        continue;
      }
      const existing = next[achievement.id];
      if (existing?.isEarned === true) {
        continue;
      }
      next[achievement.id] = {
        id: achievement.id,
        title: achievement.title,
        isEarned: true,
      };
    }
  }

  const anyBorderUseEarned = ACHIEVEMENTS.some(
    (achievement) =>
      achievement.group === 'border-use' &&
      next[achievement.id]?.isEarned === true,
  );
  if (anyBorderUseEarned) {
    const firstBorder = ACHIEVEMENTS.find(
      (achievement) => achievement.group === 'border-first',
    );
    if (firstBorder && next[firstBorder.id]?.isEarned !== true) {
      next[firstBorder.id] = {
        id: firstBorder.id,
        title: firstBorder.title,
        isEarned: true,
      };
    }
  }
  return next;
}

export function scrapeAchievementsFromDocument(
  document_: Document,
  options: {
    username?: string | undefined;
    pathHint?: string | undefined;
  } = {},
): AchievementSnapshot {
  const username =
    options.username ?? readUsernameFromDocument(document_, options.pathHint);
  const items: Record<string, AchievementProgress> = {};
  const cardCount = scrapeFromCards(document_, items);
  scrapeFromAchievementSegments(document_, items);
  if (cardCount === 0 || Object.keys(items).length < ACHIEVEMENTS.length / 4) {
    scrapeFromBodyText(document_, items);
  }
  const inferred = inferImpliedGroupEarnings(items);
  const parsedCount = parseCount(document_);
  const earnedKnown = Object.values(inferred).filter(
    (item) => item.isEarned,
  ).length;
  return {
    scrapedAt: new Date().toISOString(),
    username,
    earnedCount: parsedCount?.earned ?? earnedKnown,
    totalCount:
      parsedCount?.total ??
      Math.max(ACHIEVEMENTS.length, Object.keys(inferred).length),
    items: inferred,
  };
}

/**
Minimum items before a scrape counts as usable. Thin parses (login wall,
partial DOM) are treated as stale so the next hydrate re-fetches.
*/
const MIN_FRESH_ITEM_COUNT = 15;

function isSnapshotFresh(snapshot: AchievementSnapshot | undefined): boolean {
  if (!snapshot) {
    return false;
  }
  const itemCount = Object.keys(snapshot.items).length;
  if (itemCount < MIN_FRESH_ITEM_COUNT) {
    return false;
  }
  const now = Date.now();
  const scrapedAt = Date.parse(snapshot.scrapedAt);
  return !Number.isNaN(scrapedAt) && now - scrapedAt < ACHIEVEMENT_STALE_MS;
}

export async function loadAchievementSnapshot(): Promise<
  AchievementSnapshot | undefined
> {
  const raw: string | AchievementSnapshot | undefined =
    await GM.getValue(SNAPSHOT_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof parsed !== 'object' || !parsed) {
      return undefined;
    }
    const snapshot = parsed as AchievementSnapshot;
    return typeof snapshot.scrapedAt === 'string' &&
      typeof snapshot.items === 'object'
      ? snapshot
      : undefined;
  } catch {
    return undefined;
  }
}

/**
Keep previously scraped achievements when a later scrape is partial (one tab,
SSR shell, post-automation re-fetch). Incoming keys win; missing keys stay.
*/
export function mergeAchievementSnapshots(
  existing: AchievementSnapshot | undefined,
  incoming: AchievementSnapshot,
): AchievementSnapshot {
  if (!existing || Object.keys(existing.items).length === 0) {
    return incoming;
  }
  if (Object.keys(incoming.items).length === 0) {
    return {
      ...existing,
      scrapedAt: incoming.scrapedAt,
      username: incoming.username ?? existing.username,
    };
  }
  const items: Record<string, AchievementProgress> = { ...existing.items };
  for (const [id, progress] of Object.entries(incoming.items)) {
    const previous = items[id];
    // Never demote earned → unearned on a partial/noisy re-scrape.
    items[id] = {
      ...progress,
      isEarned: progress.isEarned || previous?.isEarned === true,
    };
  }
  const inferred = inferImpliedGroupEarnings(items);
  const earnedKnown = Object.values(inferred).filter(
    (item) => item.isEarned,
  ).length;
  return {
    scrapedAt: incoming.scrapedAt,
    username: incoming.username ?? existing.username,
    earnedCount: Math.max(incoming.earnedCount, earnedKnown),
    totalCount: Math.max(
      incoming.totalCount,
      existing.totalCount,
      Object.keys(inferred).length,
    ),
    items: inferred,
  };
}

export async function saveAchievementSnapshot(
  snapshot: AchievementSnapshot,
): Promise<AchievementSnapshot> {
  const merged = mergeAchievementSnapshots(
    await loadAchievementSnapshot(),
    snapshot,
  );
  const liveUsername = readUsernameFromDocument(document);
  const toStore =
    liveUsername && liveUsername !== merged.username
      ? { ...merged, username: liveUsername }
      : merged;
  await GM.setValue(SNAPSHOT_KEY, JSON.stringify(toStore));
  return toStore;
}

async function fetchDocument(path: string): Promise<Document | undefined> {
  try {
    const response = await fetch(path, { headers: { Accept: 'text/html' } });
    if (!response.ok) {
      console.warn('[Achievements] Failed to fetch', path, response.status);
      return undefined;
    }
    return new DOMParser().parseFromString(await response.text(), 'text/html');
  } catch (error) {
    console.warn('[Achievements] Fetch error for', path, error);
    return undefined;
  }
}

async function openPageDocument(path: string): Promise<Document | undefined> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;width:1px;height:1px;left:-9999px;top:0;opacity:0;pointer-events:none;border:0';
    const cleanup = (): void => {
      iframe.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, IFRAME_TIMEOUT_MS);
    iframe.addEventListener('load', () => {
      clearTimeout(timer);
      void delay(IFRAME_SETTLE_MS).then(() => {
        const document_ = iframe.contentDocument ?? undefined;
        cleanup();
        resolve(document_);
      });
    });
    iframe.addEventListener('error', () => {
      clearTimeout(timer);
      cleanup();
      resolve(undefined);
    });
    document.body.append(iframe);
    iframe.src = path;
  });
}

async function loadAchievementsDocument(
  path: string,
): Promise<Document | undefined> {
  const fetched = await fetchDocument(path);
  if (fetched && parseCount(fetched)) {
    const preview = scrapeAchievementsFromDocument(fetched, {
      pathHint: path,
    });
    // Count header alone is not enough — login shells / empty SSR need iframe.
    if (Object.keys(preview.items).length >= MIN_FRESH_ITEM_COUNT) {
      return fetched;
    }
    console.warn(
      '[Achievements] fetch had count but thin items; trying iframe',
      Object.keys(preview.items).length,
    );
  } else if (
    fetched &&
    matchAchievementInText(documentBody(fetched)?.textContent ?? '')
  ) {
    const preview = scrapeAchievementsFromDocument(fetched, {
      pathHint: path,
    });
    if (Object.keys(preview.items).length >= MIN_FRESH_ITEM_COUNT) {
      return fetched;
    }
  }
  return openPageDocument(path);
}

/**
Personalization item galleries are often client-filled. Prefer fetch, then
iframe when the form exists but border/avatar cards are still empty.
*/
function hasPersonalizationCosmeticItems(
  state: PersonalizationFormState,
): boolean {
  return (
    state.availableBorderIds.length > 0 ||
    state.availableAvatarIds.length > 0 ||
    state.selection.border !== undefined ||
    state.selection.avatar !== undefined
  );
}

async function loadPersonalizationDocument(): Promise<Document | undefined> {
  const fetched = await fetchDocument(PERSONALIZATION_PATH);
  if (fetched) {
    const state = readPersonalizationFormState(fetched);
    if (state && hasPersonalizationCosmeticItems(state)) {
      return fetched;
    }
    if (state) {
      console.warn(
        '[Achievements] profileCosmetics: fetch had form but no items; trying iframe',
      );
    }
  }
  return openPageDocument(PERSONALIZATION_PATH);
}

function unearthedWithAutomation(
  snapshot: AchievementSnapshot,
  key: AchievementAutomationKey,
): AchievementDefinition[] {
  return ACHIEVEMENTS.filter((achievement) => {
    return (
      achievement.automation === key &&
      snapshot.items[achievement.id]?.isEarned !== true
    );
  });
}

function articlePathsFromNews(document_: Document): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const link of document_.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/ucf/show/"], a[href*="/ucf/News"], a[href*="/blogs/"]',
  )) {
    const path = link.pathname;
    if (path === NEWS_PATH || path === '/ucf/News' || !path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
    if (paths.length >= AUTOMATION_ARTICLE_LIMIT) {
      break;
    }
  }
  return paths;
}

function videoPathsFromVideos(document_: Document): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const link of document_.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/ucf/show/"], a[href*="/ucf/Video"], a[href*="/video/"]',
  )) {
    const path = link.pathname;
    if (
      path === VIDEOS_PATH ||
      path === '/ucf/Video' ||
      !path ||
      seen.has(path)
    ) {
      continue;
    }
    seen.add(path);
    paths.push(path);
    if (paths.length >= AUTOMATION_VIDEO_LIMIT) {
      break;
    }
  }
  return paths;
}

/**
Race a promise against a timeout. Exported for unit tests.
*/
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  if (timeoutMs <= 0) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function visitPath(path: string): Promise<void> {
  const fetched = await fetchDocument(path);
  if (fetched) {
    return;
  }
  await openPageDocument(path);
}

/**
Visit paths sequentially under a wall-clock budget so iframe fallbacks cannot
block Refresh for minutes.
*/
async function visitPathsWithBudget(paths: string[]): Promise<void> {
  const deadline = Date.now() + AUTOMATION_BATCH_BUDGET_MS;
  for (const path of paths) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.warn(
        '[Achievements] automation budget exceeded; skipping remaining visits',
      );
      return;
    }
    const timeoutMs = Math.min(AUTOMATION_VISIT_TIMEOUT_MS, remaining);
    await raceWithTimeout(visitPath(path), timeoutMs);
  }
}

function parsePersonalizationItemIds(
  document_: Document,
  type: 'border' | 'avatar',
): number[] {
  const ids = new Set<number>();
  for (const element of document_.querySelectorAll<HTMLElement>(
    `.account-personalization__personalization-item[data-type="${CSS.escape(type)}"][data-id]`,
  )) {
    const value = element.dataset.id;
    if (!value) {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      ids.add(parsed);
    }
  }
  return [...ids];
}

async function assertJsonSuccess(
  response: Response,
  label: string,
): Promise<void> {
  if (!response.ok) {
    throw new Error(`${label} failed: HTTP ${response.status}`);
  }
  const rawText = await response.text();
  const text = rawText.trim();
  if (!text) {
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Non-JSON success body (some AWA endpoints return empty / HTML).
    return;
  }
  if (!data || typeof data !== 'object') {
    return;
  }
  const record = data as { success?: unknown; message?: unknown };
  if (record.success !== false) {
    return;
  }
  const message =
    typeof record.message === 'string' ? record.message : 'success: false';
  throw new Error(`${label} rejected: ${message}`);
}

function parseOptionalId(raw: string | undefined): number | undefined {
  if (!raw || raw === 'null') {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAvatarSelection(document_: Document): AvatarSelection {
  const source = document_.documentElement.textContent;
  // Current personalization page: `saved = { avatar, background, border }`.
  const match =
    /saved\s*=\s*\{\s*avatar:\s*(\d+|null)\s*,\s*background:\s*(\d+|null)\s*,\s*border:\s*(\d+|null)/i.exec(
      source,
    );
  if (match) {
    return {
      avatar: parseOptionalId(match[1]),
      background: parseOptionalId(match[2]),
      border: parseOptionalId(match[3]),
    };
  }
  const borderMatch =
    /(?:let|var|const)\s*selectedBorderId\s*=\s*(\d+)\s*;/i.exec(source);
  return {
    avatar: undefined,
    background: undefined,
    border: parseOptionalId(borderMatch?.[1]),
  };
}

function parseUserId(document_: Document): number | undefined {
  const source = document_.documentElement.textContent;
  const fromSaveUrl = /\/ajax\/user\/avatar\/save\/(\d+)/i.exec(source);
  if (fromSaveUrl?.[1]) {
    const parsed = Number(fromSaveUrl[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const fromVariable = /(?:let|var|const)\s*user_id\s*=\s*(\d+)\s*;/i.exec(
    source,
  );
  if (!fromVariable?.[1]) {
    return undefined;
  }
  const parsed = Number(fromVariable[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stripHtmlTags(html: string): string {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container.textContent.replaceAll(/\s+/g, ' ').trim();
}

function readPersonalizationFormState(
  document_: Document,
): PersonalizationFormState | undefined {
  const form = document_.querySelector<HTMLFormElement>(
    'form[action$="/account/update-personalization"]',
  );
  const token = form?.querySelector<HTMLInputElement>(
    'input[name="user_account_personalization[_token]"]',
  )?.value;
  const customTitle =
    form?.querySelector<HTMLInputElement>(
      'input[name="user_account_personalization[customTitle]"]',
    )?.value ?? '';
  const aboutHtml =
    form?.querySelector<HTMLTextAreaElement>(
      'textarea[name="user_account_personalization[about]"]',
    )?.value ?? '';
  if (!token || !form.action) {
    return undefined;
  }
  return {
    aboutAction: form.action,
    aboutToken: token,
    customTitle,
    aboutHtml,
    userId: parseUserId(document_),
    selection: parseAvatarSelection(document_),
    availableBorderIds: parsePersonalizationItemIds(document_, 'border'),
    availableAvatarIds: parsePersonalizationItemIds(document_, 'avatar'),
  };
}

async function submitPersonalizationUpdate(
  state: PersonalizationFormState,
  values: { customTitle: string; aboutHtml: string },
): Promise<void> {
  const body = new URLSearchParams({
    'user_account_personalization[customTitle]': values.customTitle,
    'user_account_personalization[about]': values.aboutHtml,
    'user_account_personalization[_token]': state.aboutToken,
  });
  const response = await fetch(state.aboutAction, {
    method: 'POST',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`POST ${state.aboutAction} failed: ${response.status}`);
  }
}

function encodeAvatarSlot(value: number | undefined): string {
  return value === undefined ? 'null' : String(value);
}

async function saveAvatarSelection(
  userId: number,
  selection: AvatarSelection,
): Promise<void> {
  // Same payload as the page's Save Avatar button.
  const response = await fetch(`/ajax/user/avatar/save/${userId}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    },
    body: `{"avatar":${encodeAvatarSlot(selection.avatar)},"background":${encodeAvatarSlot(selection.background)},"border":${encodeAvatarSlot(selection.border)}}`,
  });
  await assertJsonSuccess(response, `POST /ajax/user/avatar/save/${userId}`);
}

async function didSubmitAboutMeAutomation(
  snapshot: AchievementSnapshot,
  state: PersonalizationFormState,
): Promise<boolean> {
  if (snapshot.items['add-about-me']?.isEarned === true) {
    return false;
  }
  const cooldowns = await loadAutomationCooldowns();
  const thisMonth = utcMonthString();
  // Already submitted successfully this month — do not re-POST until next month
  // (advisor shows a muted waiting row while still unearned).
  if (cooldowns.aboutMeSubmittedMonth === thisMonth) {
    return false;
  }
  const currentAboutText = stripHtmlTags(state.aboutHtml);
  const aboutHtml = currentAboutText.length > 0 ? state.aboutHtml : '<p>Hi</p>';
  const customTitle =
    state.customTitle.trim().length > 0 ? state.customTitle : 'About me';
  console.log('[Achievements] profileCosmetics: submitting about-me', {
    customTitle,
    aboutHtml,
  });
  await submitPersonalizationUpdate(state, { customTitle, aboutHtml });
  // Only stamp the month after a successful POST (throws on failure above).
  await saveAutomationCooldowns({
    aboutMeSubmittedMonth: thisMonth,
  });
  return true;
}

/**
Still chasing "use N different borders" / first-border — extra same-day rotates
on Refresh finish those one-time achievements sooner (same lifetime ARP total).

Only when a variety tier is positively unearned *and* no higher tier in the
same chain is already earned. Stacked AWA cards often leave "Try it on" /
Use 5 marked unearned after Use 25 is done — that must not rotate on every
Refresh.
*/
export function requiresExtraBorderVariety(
  snapshot: AchievementSnapshot,
): boolean {
  const useGroup = ACHIEVEMENTS.filter(
    (achievement) => achievement.group === 'border-use',
  );
  const maxEarnedUseRank = Math.max(
    0,
    ...useGroup
      .filter(
        (achievement) => snapshot.items[achievement.id]?.isEarned === true,
      )
      .map((achievement) => achievement.rank),
  );
  if (
    useGroup.some(
      (achievement) =>
        achievement.rank > maxEarnedUseRank &&
        snapshot.items[achievement.id]?.isEarned === false,
    )
  ) {
    return true;
  }

  const firstBorder = ACHIEVEMENTS.find(
    (achievement) => achievement.group === 'border-first',
  );
  if (
    firstBorder &&
    snapshot.items[firstBorder.id]?.isEarned === false &&
    maxEarnedUseRank === 0
  ) {
    return true;
  }
  return false;
}

function canAttemptBorderRotation(
  snapshot: AchievementSnapshot,
  cooldowns: Awaited<ReturnType<typeof loadAutomationCooldowns>>,
  today: string,
  isForce: boolean,
): boolean {
  if (cooldowns.borderRotatedDate !== today) {
    return true;
  }
  // Already did today's rotate — only take another step on Refresh while
  // variety achievements are still unearned.
  return isForce && requiresExtraBorderVariety(snapshot);
}

/**
Prevent concurrent gather/ensure paths from stacking cosmetics toasts.
*/
const profileCosmeticsLock = { isRunning: false };

/**
AWA's `saved.border` / `saved.avatar` are often remapped product ids that are
not in the gallery `data-id` list. Prefer a gallery id we previously saved;
fall back to the saved id only when it appears in the gallery.
*/
function galleryRotationCursor(
  availableIds: readonly number[],
  savedProductId: number | undefined,
  lastGalleryId: number | undefined,
): number | undefined {
  if (
    lastGalleryId !== undefined &&
    availableIds.includes(lastGalleryId)
  ) {
    return lastGalleryId;
  }
  if (
    savedProductId !== undefined &&
    availableIds.includes(savedProductId)
  ) {
    return savedProductId;
  }
  return undefined;
}

/**
Gallery ids to try after `cursor` (wraps). Caps attempts so Refresh stays fast.
*/
function galleryCandidatesAfter(
  availableIds: readonly number[],
  cursor: number | undefined,
  limit = 8,
): number[] {
  if (availableIds.length === 0) {
    return [];
  }
  const sorted = availableIds.toSorted((a, b) => a - b);
  const startIndex =
    cursor === undefined ? -1 : sorted.indexOf(cursor);
  const out: number[] = [];
  const max = Math.min(limit, sorted.length);
  for (let step = 1; step <= max; step += 1) {
    const index =
      ((startIndex === -1 ? (step - 1) : (startIndex + step))) % sorted.length;
    const id = sorted[index];
    if (id === undefined || out.includes(id)) {
      continue;
    }
    // Sole equipped gallery item: still include it so unequip→reequip can run.
    if (id === cursor && sorted.length > 1) {
      continue;
    }
    out.push(id);
  }
  return out;
}

async function readSavedSelectionAfterSave(): Promise<
  AvatarSelection | undefined
> {
  const document_ = await fetchDocument(
    `${PERSONALIZATION_PATH}?_=${String(Date.now())}`,
  );
  if (!document_) {
    return undefined;
  }
  return parseAvatarSelection(document_);
}

async function saveVerifiedSlot(options: {
  userId: number;
  base: AvatarSelection;
  slot: 'border' | 'avatar';
  galleryId: number;
  beforeProductId: number | undefined;
  availableIds: readonly number[];
}): Promise<{ didChange: boolean; afterProductId: number | undefined }> {
  const { userId, base, slot, galleryId, beforeProductId, availableIds } =
    options;
  const next: AvatarSelection = { ...base, [slot]: galleryId };
  // Sole gallery border: clear first (same as re-click unequip on the page).
  if (
    slot === 'border' &&
    availableIds.length === 1 &&
    availableIds[0] === galleryId
  ) {
    await saveAvatarSelection(userId, { ...base, border: undefined });
  }
  await saveAvatarSelection(userId, next);
  const after = await readSavedSelectionAfterSave();
  const afterProductId = after?.[slot];
  return {
    didChange:
      afterProductId !== undefined && afterProductId !== beforeProductId,
    afterProductId,
  };
}

async function tryRotateGallerySlot(options: {
  userId: number;
  slot: 'border' | 'avatar';
  availableIds: readonly number[];
  workingSelection: AvatarSelection;
  lastGalleryId: number | undefined;
}): Promise<{
  didChange: boolean;
  detail: string;
  selection: AvatarSelection;
  galleryId?: number;
}> {
  const { userId, slot, availableIds, lastGalleryId } = options;
  let { workingSelection } = options;
  const beforeProductId = workingSelection[slot];
  const cursor = galleryRotationCursor(
    availableIds,
    beforeProductId,
    lastGalleryId,
  );
  const candidates = galleryCandidatesAfter(availableIds, cursor);
  console.log(`[Achievements] profileCosmetics: ${slot} candidates`, {
    savedProductId: beforeProductId,
    cursor,
    lastGalleryId,
    candidates,
  });
  for (const galleryId of candidates) {
    try {
      const result = await saveVerifiedSlot({
        userId,
        base: workingSelection,
        slot,
        galleryId,
        beforeProductId: workingSelection[slot],
        availableIds,
      });
      if (!result.didChange) {
        console.warn(
          `[Achievements] profileCosmetics: ${slot} gallery id did not stick`,
          galleryId,
          'still',
          result.afterProductId ?? workingSelection[slot],
        );
        continue;
      }
      workingSelection = {
        ...workingSelection,
        [slot]: result.afterProductId,
      };
      return {
        didChange: true,
        detail: `${slot} ${beforeProductId ?? 'none'} → ${result.afterProductId} (gallery ${galleryId})`,
        selection: workingSelection,
        galleryId,
      };
    } catch (error) {
      console.warn(
        `[Achievements] profileCosmetics: ${slot} save error`,
        galleryId,
        error,
      );
    }
  }
  return {
    didChange: false,
    detail: `${slot} unchanged (tried ${String(candidates.length)} gallery ids; saved product ${beforeProductId ?? 'none'})`,
    selection: workingSelection,
  };
}

async function saveCosmeticRotation(
  snapshot: AchievementSnapshot,
  state: PersonalizationFormState,
  cooldowns: Awaited<ReturnType<typeof loadAutomationCooldowns>>,
  today: string,
  isForce: boolean,
): Promise<{ didChange: boolean; detail: string }> {
  if (state.userId === undefined) {
    return { didChange: false, detail: 'no userId for avatar save' };
  }

  const isWantsBorder = canAttemptBorderRotation(
    snapshot,
    cooldowns,
    today,
    isForce,
  );
  const isWantsAvatar = cooldowns.avatarRotatedDate !== today;
  if (!isWantsBorder && !isWantsAvatar) {
    return {
      didChange: false,
      detail: `already rotated today (border ${cooldowns.borderRotatedDate ?? '—'}, avatar ${cooldowns.avatarRotatedDate ?? '—'})`,
    };
  }
  if (state.availableBorderIds.length + state.availableAvatarIds.length === 0) {
    return { didChange: false, detail: 'no avatar/border gallery items found' };
  }

  const parts: string[] = [];
  const cooldownPatch: {
    borderRotatedDate?: string;
    borderGalleryId?: number;
    avatarRotatedDate?: string;
    avatarGalleryId?: number;
  } = {};
  let workingSelection: AvatarSelection = { ...state.selection };
  let didChange = false;

  if (isWantsBorder && state.availableBorderIds.length > 0) {
    const borderResult = await tryRotateGallerySlot({
      userId: state.userId,
      slot: 'border',
      availableIds: state.availableBorderIds,
      workingSelection,
      lastGalleryId: cooldowns.borderGalleryId,
    });
    parts.push(borderResult.detail);
    workingSelection = borderResult.selection;
    if (borderResult.didChange && borderResult.galleryId !== undefined) {
      cooldownPatch.borderRotatedDate = today;
      cooldownPatch.borderGalleryId = borderResult.galleryId;
      didChange = true;
    }
  }

  if (isWantsAvatar && state.availableAvatarIds.length > 0) {
    const avatarResult = await tryRotateGallerySlot({
      userId: state.userId,
      slot: 'avatar',
      availableIds: state.availableAvatarIds,
      workingSelection,
      lastGalleryId: cooldowns.avatarGalleryId,
    });
    parts.push(avatarResult.detail);
    if (avatarResult.didChange && avatarResult.galleryId !== undefined) {
      cooldownPatch.avatarRotatedDate = today;
      cooldownPatch.avatarGalleryId = avatarResult.galleryId;
      didChange = true;
    }
  }

  if (didChange) {
    await saveAutomationCooldowns(cooldownPatch);
  }

  return {
    didChange,
    detail: parts.join('; ') || 'no cosmetic changes applied',
  };
}

async function didApplyVisitPagesAutomation(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
): Promise<boolean> {
  if (
    !isAchievementAutomationEnabled(settings, 'visitPages') ||
    unearthedWithAutomation(snapshot, 'visitPages').length === 0
  ) {
    return false;
  }
  const cooldowns = await loadAutomationCooldowns();
  const today = utcDateString();
  if (cooldowns.visitPagesDate === today) {
    return false;
  }
  await visitPathsWithBudget([FAQ_PATH, HIVE_PATH]);
  await saveAutomationCooldowns({ visitPagesDate: today });
  return true;
}

async function didApplyProfileCosmeticsAutomation(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
  isForce = false,
): Promise<boolean> {
  // Always run when enabled — streak achievements (daily/monthly border & avatar
  // changes) require ongoing action even after earlier ones in the group are earned.
  if (!isAchievementAutomationEnabled(settings, 'profileCosmetics')) {
    return false;
  }
  if (profileCosmeticsLock.isRunning) {
    console.log(
      '[Achievements] profileCosmetics: skipped overlapping run',
    );
    return false;
  }
  profileCosmeticsLock.isRunning = true;
  try {
    const personalization = await loadPersonalizationDocument();
    if (!personalization) {
      console.warn(
        '[Achievements] profileCosmetics: failed to fetch personalization page',
      );
      return false;
    }

    const state = readPersonalizationFormState(personalization);
    if (!state) {
      console.warn(
        '[Achievements] profileCosmetics: could not read form state — update-personalization form or token not found',
      );
      return false;
    }
    console.log('[Achievements] profileCosmetics: state', {
      userId: state.userId,
      selection: state.selection,
      borderCount: state.availableBorderIds.length,
      avatarCount: state.availableAvatarIds.length,
      isForce,
    });

    const cooldowns = await loadAutomationCooldowns();
    const today = utcDateString();
    const didAboutMe = await didSubmitAboutMeAutomation(snapshot, state);
    const cosmeticResult = await saveCosmeticRotation(
      snapshot,
      state,
      cooldowns,
      today,
      isForce,
    );
    const notes = [
      didAboutMe ? 'about-me submitted' : undefined,
      cosmeticResult.detail,
    ].filter((note): note is string => Boolean(note));
    console.log('[Achievements] profileCosmetics: result', notes);
    const didChange = didAboutMe || cosmeticResult.didChange;
    const isWantsBorderAttempt = canAttemptBorderRotation(
      snapshot,
      cooldowns,
      today,
      isForce,
    );
    const isWantsAvatarAttempt = cooldowns.avatarRotatedDate !== today;
    if (didChange) {
      showAoToast(
        `Achievements cosmetics: ${[
          didAboutMe ? 'about-me' : undefined,
          cosmeticResult.didChange ? cosmeticResult.detail : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' · ')}`,
      );
    } else if (isWantsBorderAttempt || isWantsAvatarAttempt) {
      showAoToast(`Achievements cosmetics skipped: ${notes.join(' · ')}`);
    }
    return didChange;
  } finally {
    profileCosmeticsLock.isRunning = false;
  }
}

async function didApplyGameVaultAutomation(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
): Promise<boolean> {
  if (
    !isAchievementAutomationEnabled(settings, 'gameVault') ||
    unearthedWithAutomation(snapshot, 'gameVault').length === 0
  ) {
    return false;
  }
  const cooldowns = await loadAutomationCooldowns();
  const today = utcDateString();
  if (cooldowns.gameVaultDate === today) {
    return false;
  }
  await visitPath(GAME_VAULT_PATH);
  await saveAutomationCooldowns({ gameVaultDate: today });
  return true;
}

async function didApplyReadArticlesAutomation(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
): Promise<boolean> {
  if (
    !isAchievementAutomationEnabled(settings, 'readArticles') ||
    unearthedWithAutomation(snapshot, 'readArticles').length === 0
  ) {
    return false;
  }
  const cooldowns = await loadAutomationCooldowns();
  const today = utcDateString();
  if (cooldowns.readArticlesDate === today) {
    return false;
  }
  const news = await fetchDocument(NEWS_PATH);
  const articlePaths = news ? articlePathsFromNews(news) : [];
  if (articlePaths.length === 0) {
    await visitPathsWithBudget([NEWS_PATH]);
  } else {
    await visitPathsWithBudget(articlePaths);
  }
  await saveAutomationCooldowns({ readArticlesDate: today });
  return true;
}

async function didApplyWatchVideosAutomation(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
): Promise<boolean> {
  if (
    !isAchievementAutomationEnabled(settings, 'watchVideos') ||
    unearthedWithAutomation(snapshot, 'watchVideos').length === 0
  ) {
    return false;
  }
  const cooldowns = await loadAutomationCooldowns();
  const today = utcDateString();
  if (cooldowns.watchVideosDate === today) {
    return false;
  }
  const videos = await fetchDocument(VIDEOS_PATH);
  const videoPaths = videos ? videoPathsFromVideos(videos) : [];
  if (videoPaths.length === 0) {
    await visitPathsWithBudget([VIDEOS_PATH]);
  } else {
    await visitPathsWithBudget(videoPaths);
  }
  await saveAutomationCooldowns({ watchVideosDate: today });
  return true;
}

async function didApplyAchievementAutomations(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
  isForce = false,
): Promise<boolean> {
  const applied = await Promise.all([
    didApplyVisitPagesAutomation(snapshot, settings),
    didApplyProfileCosmeticsAutomation(snapshot, settings, isForce),
    didApplyGameVaultAutomation(snapshot, settings),
    didApplyReadArticlesAutomation(snapshot, settings),
    didApplyWatchVideosAutomation(snapshot, settings),
  ]);
  return applied.some(Boolean);
}

/**
Run enabled achievement automations, then refresh the snapshot if anything applied.
Used by gatherData on the achievements page (which otherwise only scrapes).
*/
export async function runAchievementAutomations(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
  options: { isForce?: boolean } = {},
): Promise<AchievementSnapshot> {
  if (!settings.runAutomatically) {
    return snapshot;
  }
  const isForce = options.isForce === true;
  return (await didApplyAchievementAutomations(snapshot, settings, isForce))
    ? refreshSnapshotAfterAutomation(
        snapshot,
        readUsernameFromDocument(document) ?? snapshot.username,
      )
    : snapshot;
}

export function requiresAchievementHydrate(
  snapshot: AchievementSnapshot | undefined,
  isEnabled = true,
  isForce = false,
): boolean {
  if (!isEnabled) {
    return false;
  }
  return isForce || !isSnapshotFresh(snapshot);
}

async function scrapeAchievementsSnapshot(
  username: string | undefined,
): Promise<AchievementSnapshot | undefined> {
  if (isAchievementsPage()) {
    await waitForAchievementsDocument();
    return scrapeAchievementsFromDocument(
      document,
      scrapeOptions({ username }),
    );
  }
  const path = resolveAchievementsUrl(username);
  if (!path) {
    return emptySnapshot(username);
  }
  const document_ = await loadAchievementsDocument(path);
  return document_
    ? scrapeAchievementsFromDocument(
        document_,
        scrapeOptions({ username, pathHint: path }),
      )
    : undefined;
}

async function refreshSnapshotAfterAutomation(
  snapshot: AchievementSnapshot,
  username: string | undefined,
): Promise<AchievementSnapshot> {
  const resolvedUsername =
    readUsernameFromDocument(document) ?? snapshot.username ?? username;
  const path = resolveAchievementsUrl(resolvedUsername);
  // Always prefer a fresh fetch — the live achievements page DOM will not
  // update in-place after a background avatar save.
  if (path) {
    const refreshed = await loadAchievementsDocument(path);
    if (refreshed) {
      return scrapeAchievementsFromDocument(
        refreshed,
        scrapeOptions({ username: resolvedUsername, pathHint: path }),
      );
    }
  }
  if (isAchievementsPage()) {
    await waitForAchievementsDocument();
    return scrapeAchievementsFromDocument(
      document,
      scrapeOptions({ username: resolvedUsername }),
    );
  }
  return snapshot;
}

function isForceWithinCooldown(existing: AchievementSnapshot): boolean {
  const scrapedAt = Date.parse(existing.scrapedAt);
  return (
    !Number.isNaN(scrapedAt) &&
    Date.now() - scrapedAt < FORCE_REFRESH_COOLDOWN_MS
  );
}

export async function ensureAchievementSnapshot(
  options: {
    force?: boolean | undefined;
    username?: string | undefined;
    /**
    User clicked Refresh — may take an extra same-day border step toward
    unearned "use N borders". Do not set for background/empty-cache scrapes.
    */
    isUserRefresh?: boolean | undefined;
  } = {},
): Promise<AchievementSnapshot | undefined> {
  const existing = await loadAchievementSnapshot();
  const liveUsername = readUsernameFromDocument(document);
  // Live page first — options/cache still hold the pre-rename name after a change.
  const username =
    liveUsername ?? options.username ?? existing?.username;
  const isForce = options.force === true;
  const isUserRefresh = options.isUserRefresh === true;
  const settings = await getAchievementSettings();

  // When the snapshot is still fresh and this isn't a forced refresh, skip
  // re-scraping — but still run automations so they always fire when enabled.
  if (!isForce && isSnapshotFresh(existing)) {
    if (existing && settings.runAutomatically) {
      await didApplyAchievementAutomations(existing, settings, isUserRefresh);
    }
    return existing;
  }
  if (isForce && existing && isForceWithinCooldown(existing)) {
    if (settings.runAutomatically) {
      await didApplyAchievementAutomations(existing, settings, isUserRefresh);
    }
    return existing;
  }

  let snapshot = await scrapeAchievementsSnapshot(username);
  const itemCount = snapshot ? Object.keys(snapshot.items).length : 0;
  if (!snapshot || itemCount < MIN_FRESH_ITEM_COUNT) {
    console.warn('[Achievements] scrape unusable; keeping previous snapshot', {
      itemCount,
      hadExisting: Boolean(existing),
    });
    // Still run automations so border/avatar rotation is not stuck behind a
    // bad achievements fetch (Updated stamp may stay old until scrape works).
    if (existing && settings.runAutomatically) {
      await didApplyAchievementAutomations(existing, settings, isUserRefresh);
    }
    return existing ?? snapshot;
  }

  if (
    await didApplyAchievementAutomations(snapshot, settings, isUserRefresh)
  ) {
    snapshot = await refreshSnapshotAfterAutomation(snapshot, username);
  }

  return saveAchievementSnapshot(snapshot);
}
