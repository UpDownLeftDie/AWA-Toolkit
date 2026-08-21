import { GM } from '$';
import { readPageUsername } from '../pageGlobals';
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
const STALE_MS = 6 * 60 * 60 * 1000;
const FORCE_REFRESH_COOLDOWN_MS = 5 * 1000;
const IFRAME_TIMEOUT_MS = 15_000;
const IFRAME_SETTLE_MS = 400;
const PERSONALIZATION_PATH = '/account/personalization';
const AUTOMATION_ARTICLE_LIMIT = 10;
const AUTOMATION_VIDEO_LIMIT = 10;
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
  availableBorderIds: number[];
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
  if (hrefMatch?.[1]) {
    return decodeURIComponent(hrefMatch[1]);
  }
  return undefined;
}

export function resolveAchievementsUrl(username?: string): string | undefined {
  const name = username ?? readUsernameFromDocument(document);
  if (!name) {
    return undefined;
  }
  return `/member/${encodeURIComponent(name)}/achievements`;
}

function emptySnapshot(username: string | undefined): AchievementSnapshot {
  return {
    scrapedAt: new Date(0).toISOString(),
    username,
    earnedCount: 0,
    totalCount: ACHIEVEMENTS.length,
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
  const fromBody = parseCountFromText(document_.body?.textContent ?? '');
  if (fromBody) {
    return fromBody;
  }
  for (const element of document_.querySelectorAll(
    'h1, h2, h3, h4, h5, strong, span, div, p',
  )) {
    const text = element.textContent ?? '';
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
    if (start === -1 || index < start) {
      start = index;
      matchedLength = name.length;
    }
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
  if (card.classList.contains('unachieved')) {
    return true;
  }
  if (card.classList.contains('achieved')) {
    return false;
  }
  return !isEarnedCardText(card.textContent ?? '');
}

function scrapeFromCards(
  document_: Document,
  items: Record<string, AchievementProgress>,
): number {
  // Prefer leaf cards — parent rows match too many class substrings and mix
  // earned/unearned text into one blob.
  const preferred = document_.querySelectorAll('.achievement-card');
  const nodes = preferred.length > 0 ? preferred : document_.querySelectorAll(CARD_SELECTOR);
  for (const card of nodes) {
    const nestedCards = card.querySelectorAll('.achievement-card');
    // Skip wrappers that contain multiple child cards
    if (nestedCards.length > 1) {
      continue;
    }
    const text = card.textContent ?? '';
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
  const collapsed = (document_.body?.textContent ?? '').replaceAll(/\s+/g, ' ');
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
  if (segment === undefined) {
    return undefined;
  }
  return isEarnedCardText(segment);
}

function scrapeFromBodyText(
  document_: Document,
  items: Record<string, AchievementProgress>,
): void {
  const collapsed = (document_.body?.textContent ?? '').replaceAll(/\s+/g, ' ');
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

export function scrapeAchievementsFromDocument(
  document_: Document,
  options: { username?: string | undefined; pathHint?: string | undefined } = {},
): AchievementSnapshot {
  const username =
    options.username ?? readUsernameFromDocument(document_, options.pathHint);
  const items: Record<string, AchievementProgress> = {};
  const cardCount = scrapeFromCards(document_, items);
  scrapeFromAchievementSegments(document_, items);
  if (cardCount === 0 || Object.keys(items).length < ACHIEVEMENTS.length / 4) {
    scrapeFromBodyText(document_, items);
  }
  const parsedCount = parseCount(document_);
  const earnedKnown = Object.values(items).filter(
    (item) => item.isEarned,
  ).length;
  return {
    scrapedAt: new Date().toISOString(),
    username,
    earnedCount: parsedCount?.earned ?? earnedKnown,
    totalCount:
      parsedCount?.total ??
      Math.max(ACHIEVEMENTS.length, Object.keys(items).length),
    items,
  };
}

function isSnapshotFresh(
  snapshot: AchievementSnapshot | undefined,
  now = Date.now(),
): boolean {
  if (!snapshot || Object.keys(snapshot.items).length === 0) {
    return false;
  }
  const scrapedAt = Date.parse(snapshot.scrapedAt);
  if (Number.isNaN(scrapedAt)) {
    return false;
  }
  return now - scrapedAt < STALE_MS;
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
    if (
      typeof snapshot.scrapedAt !== 'string' ||
      typeof snapshot.items !== 'object'
    ) {
      return undefined;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

export async function saveAchievementSnapshot(
  snapshot: AchievementSnapshot,
): Promise<void> {
  await GM.setValue(SNAPSHOT_KEY, JSON.stringify(snapshot));
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
    return fetched;
  }
  if (fetched && matchAchievementInText(fetched.body?.textContent ?? '')) {
    return fetched;
  }
  return openPageDocument(path);
}

function unearthedWithAutomation(
  snapshot: AchievementSnapshot,
  key: AchievementAutomationKey,
): AchievementDefinition[] {
  return ACHIEVEMENTS.filter((achievement) => {
    if (achievement.automation !== key) {
      return false;
    }
    return snapshot.items[achievement.id]?.isEarned !== true;
  });
}

function articlePathsFromNews(document_: Document): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const link of document_.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/ucf/show/"], a[href*="/news/"], a[href*="/blogs/"]',
  )) {
    const path = link.pathname;
    if (path === NEWS_PATH || !path || seen.has(path)) {
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
    'a[href*="/ucf/show/"], a[href*="/videos/"], a[href*="/video/"]',
  )) {
    const path = link.pathname;
    if (path === VIDEOS_PATH || !path || seen.has(path)) {
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

async function visitPath(path: string): Promise<void> {
  const fetched = await fetchDocument(path);
  if (fetched) {
    return;
  }
  await openPageDocument(path);
}

function parseSelectedBorderId(document_: Document): number | undefined {
  const source = document_.documentElement?.textContent ?? '';
  const fromSaved = /saved\s*=\s*\{[^}]*\bborder\s*:\s*(\d+)/i.exec(source);
  if (fromSaved?.[1]) {
    const parsed = Number(fromSaved[1]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const match =
    /(?:let|var|const)\s*selectedBorderId\s*=\s*(\d+)\s*;/i.exec(source) ??
    /(?:let|var|const)\s*selectedBorder\s*=\s*(\d+)\s*;/i.exec(source);
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function parseOptionalId(raw: string | undefined): number | undefined {
  if (!raw || raw === 'null') {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAvatarSelection(document_: Document): AvatarSelection {
  const source = document_.documentElement?.textContent ?? '';
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
  return {
    avatar: undefined,
    background: undefined,
    border: parseSelectedBorderId(document_),
  };
}

function parseUserId(document_: Document): number | undefined {
  const source = document_.documentElement?.textContent ?? '';
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

function pickNextItemId(
  availableIds: readonly number[],
  selectedId: number | undefined,
): number | undefined {
  if (availableIds.length === 0) {
    return undefined;
  }
  const sorted = availableIds.toSorted((a, b) => a - b);
  if (selectedId === undefined) {
    return sorted[0];
  }
  const currentIndex = sorted.indexOf(selectedId);
  if (currentIndex === -1) {
    return sorted[0];
  }
  if (sorted.length === 1) {
    return undefined;
  }
  return sorted[(currentIndex + 1) % sorted.length];
}

function stripHtmlTags(html: string): string {
  const container = document.createElement('div');
  container.innerHTML = html;
  return (container.textContent ?? '').replaceAll(/\s+/g, ' ').trim();
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
  if (!token || !form?.action) {
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
  // Wire format uses JSON null for unset layers (AWA API).
  const response = await fetch(`/ajax/user/avatar/save/${userId}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    },
    body: `{"avatar":${encodeAvatarSlot(selection.avatar)},"background":${encodeAvatarSlot(selection.background)},"border":${encodeAvatarSlot(selection.border)}}`,
  });
  if (!response.ok) {
    throw new Error(
      `POST /ajax/user/avatar/save/${userId} failed: ${response.status}`,
    );
  }
}

async function didSubmitAboutMeAutomation(
  snapshot: AchievementSnapshot,
  state: PersonalizationFormState,
): Promise<boolean> {
  if (snapshot.items['add-about-me']?.isEarned === true) {
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
  await saveAutomationCooldowns({
    aboutMeSubmittedMonth: utcMonthString(),
  });
  return true;
}

function requiresBorderRotationRetry(snapshot: AchievementSnapshot): boolean {
  // One-shot / "use N borders" progress — retry even if today's cooldown was
  // set by a failed or uncredited save. Streaks (daily/monthly) still honor cooldown.
  return ACHIEVEMENTS.some(
    (achievement) =>
      achievement.group === 'border-use' &&
      achievement.automation === 'profileCosmetics' &&
      snapshot.items[achievement.id]?.isEarned !== true,
  );
}

function planDailyAvatarSelection(
  snapshot: AchievementSnapshot,
  state: PersonalizationFormState,
  cooldowns: Awaited<ReturnType<typeof loadAutomationCooldowns>>,
  today: string,
): { selection: AvatarSelection; shouldSave: boolean } {
  const nextSelection: AvatarSelection = { ...state.selection };
  let shouldSave = false;

  const nextBorderId = pickNextItemId(
    state.availableBorderIds,
    state.selection.border,
  );
  const canRotateBorder =
    cooldowns.borderRotatedDate !== today ||
    requiresBorderRotationRetry(snapshot);
  if (
    canRotateBorder &&
    nextBorderId !== undefined &&
    nextBorderId !== state.selection.border
  ) {
    nextSelection.border = nextBorderId;
    shouldSave = true;
  }

  const nextAvatarId = pickNextItemId(
    state.availableAvatarIds,
    state.selection.avatar,
  );
  if (
    nextAvatarId !== undefined &&
    cooldowns.avatarRotatedDate !== today &&
    nextAvatarId !== state.selection.avatar
  ) {
    nextSelection.avatar = nextAvatarId;
    shouldSave = true;
  }

  return { selection: nextSelection, shouldSave };
}

async function didSaveDailyAvatarRotation(
  snapshot: AchievementSnapshot,
  state: PersonalizationFormState,
  cooldowns: Awaited<ReturnType<typeof loadAutomationCooldowns>>,
  today: string,
): Promise<boolean> {
  if (state.userId === undefined) {
    console.warn('[Achievements] profileCosmetics: no userId for avatar save');
    return false;
  }
  const plan = planDailyAvatarSelection(snapshot, state, cooldowns, today);
  console.log('[Achievements] profileCosmetics: avatar save plan', {
    from: state.selection,
    to: plan.selection,
    shouldSave: plan.shouldSave,
    lastBorderDate: cooldowns.borderRotatedDate,
    lastAvatarDate: cooldowns.avatarRotatedDate,
    today,
  });
  if (!plan.shouldSave) {
    return false;
  }
  await saveAvatarSelection(state.userId, plan.selection);
  const cooldownPatch: {
    borderRotatedDate?: string;
    avatarRotatedDate?: string;
  } = {};
  if (plan.selection.border !== state.selection.border) {
    cooldownPatch.borderRotatedDate = today;
  }
  if (plan.selection.avatar !== state.selection.avatar) {
    cooldownPatch.avatarRotatedDate = today;
  }
  await saveAutomationCooldowns(cooldownPatch);
  return true;
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
  await visitPath(FAQ_PATH);
  await visitPath(HIVE_PATH);
  await saveAutomationCooldowns({ visitPagesDate: today });
  return true;
}

async function didApplyProfileCosmeticsAutomation(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
): Promise<boolean> {
  // Always run when enabled — streak achievements (daily/monthly border & avatar
  // changes) require ongoing action even after earlier ones in the group are earned.
  if (!isAchievementAutomationEnabled(settings, 'profileCosmetics')) {
    return false;
  }
  const personalization = await fetchDocument(PERSONALIZATION_PATH);
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
  });

  const cooldowns = await loadAutomationCooldowns();
  const today = utcDateString();
  const didAboutMe = await didSubmitAboutMeAutomation(snapshot, state);
  const didAvatar = await didSaveDailyAvatarRotation(
    snapshot,
    state,
    cooldowns,
    today,
  );
  return didAboutMe || didAvatar;
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
    await visitPath(NEWS_PATH);
  } else {
    for (const path of articlePaths) {
      await visitPath(path);
    }
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
    await visitPath(VIDEOS_PATH);
  } else {
    for (const path of videoPaths) {
      await visitPath(path);
    }
  }
  await saveAutomationCooldowns({ watchVideosDate: today });
  return true;
}

async function didApplyAchievementAutomations(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
): Promise<boolean> {
  const applied = await Promise.all([
    didApplyVisitPagesAutomation(snapshot, settings),
    didApplyProfileCosmeticsAutomation(snapshot, settings),
    didApplyGameVaultAutomation(snapshot, settings),
    didApplyReadArticlesAutomation(snapshot, settings),
    didApplyWatchVideosAutomation(snapshot, settings),
  ]);
  return applied.some(Boolean);
}

/**
 * Run enabled achievement automations, then refresh the snapshot if anything applied.
 * Used by gatherData on the achievements page (which otherwise only scrapes).
 */
export async function runAchievementAutomations(
  snapshot: AchievementSnapshot,
  settings: AchievementSettings,
): Promise<AchievementSnapshot> {
  if (!settings.runAutomatically) {
    return snapshot;
  }
  if (!(await didApplyAchievementAutomations(snapshot, settings))) {
    return snapshot;
  }
  return refreshSnapshotAfterAutomation(snapshot, snapshot.username);
}

export function requiresAchievementHydrate(
  snapshot: AchievementSnapshot | undefined,
  isEnabled = true,
  isForce = false,
): boolean {
  if (!isEnabled) {
    return false;
  }
  if (isForce) {
    return true;
  }
  return !isSnapshotFresh(snapshot);
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
  if (!document_) {
    return undefined;
  }
  return scrapeAchievementsFromDocument(
    document_,
    scrapeOptions({ username, pathHint: path }),
  );
}

async function refreshSnapshotAfterAutomation(
  snapshot: AchievementSnapshot,
  username: string | undefined,
): Promise<AchievementSnapshot> {
  const resolvedUsername = snapshot.username ?? username;
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
  if (Number.isNaN(scrapedAt)) {
    return false;
  }
  return Date.now() - scrapedAt < FORCE_REFRESH_COOLDOWN_MS;
}

export async function ensureAchievementSnapshot(
  options: {
    force?: boolean | undefined;
    username?: string | undefined;
  } = {},
): Promise<AchievementSnapshot | undefined> {
  const existing = await loadAchievementSnapshot();
  const username =
    options.username ??
    existing?.username ??
    readUsernameFromDocument(document);
  const isForce = options.force === true;
  const settings = await getAchievementSettings();

  // When the snapshot is still fresh and this isn't a forced refresh, skip
  // re-scraping — but still run automations so they always fire when enabled.
  if (!isForce && isSnapshotFresh(existing)) {
    if (existing && settings.runAutomatically) {
      await didApplyAchievementAutomations(existing, settings);
    }
    return existing;
  }
  if (isForce && existing && isForceWithinCooldown(existing)) {
    if (settings.runAutomatically) {
      await didApplyAchievementAutomations(existing, settings);
    }
    return existing;
  }

  let snapshot = await scrapeAchievementsSnapshot(username);
  if (!snapshot || Object.keys(snapshot.items).length === 0) {
    return existing ?? snapshot;
  }

  if (await didApplyAchievementAutomations(snapshot, settings)) {
    snapshot = await refreshSnapshotAfterAutomation(snapshot, username);
  }

  await saveAchievementSnapshot(snapshot);
  return snapshot;
}
