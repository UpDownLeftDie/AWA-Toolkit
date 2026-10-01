import { claimBattlePassReward } from '../api';
import { pageText } from './shared';
import type { SiteState } from './types';

export interface BattlePassReadyClaim {
  milestoneId: string;
  isArp: boolean;
  /**
   * Form `action` (`/battle-pass/claim/{instanceId}`). The path id is a
   * per-user claim instance, not `milestoneId`.
   */
  claimPath?: string;
  csrfToken?: string;
  body?: Record<string, unknown>;
}

export interface BattlePassState {
  tokens?: number;
  tokensMax?: number;
  /**
  Total milestones with a CLAIM button (ARP, fragments, cosmetics, …).
  */
  readyToClaim: number;
  /**
  Claimable ARP Boost (or flat ARP) milestones — these are multiplied by All-ARP%.
  */
  readyToClaimArp: number;
  /**
  Ready CLAIM targets scraped from the track (form action + csrf for POSTs).
  */
  readyClaims?: BattlePassReadyClaim[];
  endsInText?: string;
  /**
  Absolute end from the on-page countdown at scrape time (not a 24h slot lock).
  */
  endsAt?: string;
  url: string;
  scrapedAt: string;
}

const BATTLE_PASS_SEASON_RE = /\/battle-pass\/(\d+)/;
/**
Seasons are about one quarter apart. Walk this far past the last known id so
a season that ended (public page redirects to login, like `/battle-pass/1`)
does not hide the next live pass.
*/
const BATTLE_PASS_SEASON_LOOKAHEAD = 6;
const BATTLE_PASS_PATH_CACHE_MS = 15 * 60 * 1000;

const battlePassPathCache: { at: number; path?: string } = { at: 0 };

export function battlePassSeasonId(href: string | undefined): number | undefined {
  if (!href) {
    return undefined;
  }
  const match = BATTLE_PASS_SEASON_RE.exec(href);
  if (!match?.[1]) {
    return undefined;
  }
  const seasonId = Number(match[1]);
  return Number.isSafeInteger(seasonId) && seasonId > 0 ? seasonId : undefined;
}

/**
 * Personal track. Public `/battle-pass/{id}` is the rewards preview.
 */
export function battlePassControlCenterPath(
  href: string | undefined,
): string | undefined {
  const seasonId = battlePassSeasonId(href);
  return seasonId === undefined
    ? undefined
    : `/control-center/battle-pass/${seasonId}`;
}

function highestBattlePassSeasonId(
  document_: Document,
  selector: string,
): number | undefined {
  let newest: number | undefined;
  for (const node of document_.querySelectorAll(selector)) {
    const seasonId = battlePassSeasonId(node.getAttribute('href') ?? undefined);
    if (seasonId === undefined) {
      continue;
    }
    if (newest === undefined || seasonId > newest) {
      newest = seasonId;
    }
  }
  return newest;
}

/**
 * Current season from the site's own links.
 * Logged-in Control Center puts it on the account menu (`a.um-nav-link`).
 * The homepage widget (`.bp-widget a`) is the same pointer when that tile is
 * present. Other `/battle-pass/{id}` links are a fallback; the highest id wins.
 */
export function battlePassPathFromDocument(
  document_: Document | undefined,
): string | undefined {
  if (!document_) {
    return undefined;
  }
  const seasonId =
    highestBattlePassSeasonId(
      document_,
      'a.um-nav-link[href*="/battle-pass/"]',
    ) ??
    highestBattlePassSeasonId(
      document_,
      '.bp-widget a[href*="/battle-pass/"]',
    ) ??
    highestBattlePassSeasonId(document_, 'a[href*="/battle-pass/"]');
  return seasonId === undefined
    ? undefined
    : `/control-center/battle-pass/${seasonId}`;
}

/**
 * Control Center sometimes links the live season the public pages have not
 * caught up to. Never step backwards onto an ended pass.
 */
export function newerBattlePassPath(
  current: string | undefined,
  document_: Document | undefined,
): string | undefined {
  const linked = battlePassPathFromDocument(document_);
  const linkedId = battlePassSeasonId(linked);
  const currentId = battlePassSeasonId(current);
  if (
    linked &&
    linkedId !== undefined &&
    (currentId === undefined || linkedId > currentId)
  ) {
    return linked;
  }
  return current;
}

export function isPublicBattlePassSeasonPage(options: {
  ok: boolean;
  finalUrl: string;
  html: string;
}): boolean {
  if (!options.ok || isLoginUrl(options.finalUrl)) {
    return false;
  }
  return /class=["'][^"']*\bbp-(?:landing|popup)\b/.test(options.html);
}

function isLoginUrl(finalUrl: string): boolean {
  try {
    const pathname = new URL(finalUrl, 'https://www.alienwarearena.com').pathname;
    return pathname === '/login' || pathname.startsWith('/login/');
  } catch {
    return false;
  }
}

async function isLivePublicBattlePassSeason(seasonId: number): Promise<boolean> {
  const response = await fetch(`/battle-pass/${seasonId}`, {
    headers: { Accept: 'text/html' },
  });
  const html = response.ok ? await response.text() : '';
  return isPublicBattlePassSeasonPage({
    ok: response.ok,
    finalUrl: response.url || `/battle-pass/${seasonId}`,
    html,
  });
}

async function newestLiveSeasonId(
  startId: number,
  isLiveSeason: (seasonId: number) => Promise<boolean>,
): Promise<number | undefined> {
  let newest: number | undefined;
  const lastId = startId + BATTLE_PASS_SEASON_LOOKAHEAD;
  for (let seasonId = startId; seasonId <= lastId; seasonId += 1) {
    let isLive: boolean;
    try {
      isLive = await isLiveSeason(seasonId);
    } catch {
      return newest;
    }
    if (!isLive) {
      if (newest !== undefined) {
        return newest;
      }
      continue;
    }
    newest = seasonId;
  }
  return newest;
}

/**
 * Control-center path of the newest live season. Ended passes (public URL
 * redirects to login) are skipped. A known url is only the floor we search
 * from; a newer `/battle-pass/{id}` replaces it.
 */
export async function discoverBattlePassPath(
  options: {
    knownUrl?: string | undefined;
    hintDocument?: Document;
    force?: boolean;
    isLiveSeason?: (seasonId: number) => Promise<boolean>;
  } = {},
): Promise<string | undefined> {
  const shouldRememberPath = options.isLiveSeason === undefined;
  if (
    shouldRememberPath &&
    options.force !== true &&
    battlePassPathCache.path &&
    Date.now() - battlePassPathCache.at < BATTLE_PASS_PATH_CACHE_MS
  ) {
    return battlePassPathCache.path;
  }

  const hintedIds = [
    battlePassSeasonId(options.knownUrl),
    battlePassSeasonId(battlePassPathFromDocument(options.hintDocument)),
    battlePassSeasonId(battlePassPathFromDocument(document)),
    battlePassSeasonId(globalThis.location?.pathname),
  ].filter((seasonId): seasonId is number => seasonId !== undefined);
  const startId = hintedIds.length > 0 ? Math.max(...hintedIds) : 1;
  const newest = await newestLiveSeasonId(
    startId,
    options.isLiveSeason ?? isLivePublicBattlePassSeason,
  );
  const path =
    newest === undefined
      ? battlePassControlCenterPath(options.knownUrl)
      : `/control-center/battle-pass/${newest}`;
  if (shouldRememberPath && path) {
    battlePassPathCache.at = Date.now();
    battlePassPathCache.path = path;
  }
  return path;
}

function isStaticBattlePassPreview(document_: Document): boolean {
  return Boolean(
    document_.querySelector('.bp-landing--static, .bp-landing__login-prompt') &&
      !document_.querySelector(
        '.bp-popup__claim-btn, .bp-popup__claimed, form[data-claim-form]',
      ),
  );
}

export function scrapeBattlePassFromDocument(
  document_: Document,
  pageUrl?: string,
): BattlePassState | undefined {
  const body = pageText(document_);
  const popups = document_.querySelectorAll('.bp-popup[data-milestone-id]');
  const tokensMatch = /BATTLE TOKENS\s*([\d,]+)\s*\/\s*([\d,]+)/i.exec(body);
  const legacyClaims = (body.match(/Ready to claim/gi) ?? []).length;
  // Tokens can be in the fetch HTML while claim popups are client-rendered.
  // Treat that as "not loaded" so we don't cache 0 ready over real boosts.
  if (legacyClaims === 0 && popups.length === 0) {
    return undefined;
  }
  // `/battle-pass/{id}` is a logged-out rewards map (every milestone locked).
  // Caching that as 0 ready would wipe the personal track.
  if (isStaticBattlePassPreview(document_)) {
    return undefined;
  }

  const url =
    battlePassControlCenterPath(pageUrl) ??
    battlePassPathFromDocument(document_) ??
    battlePassControlCenterPath(globalThis.location?.pathname);
  if (!url) {
    return undefined;
  }

  const readyClaims = listReadyClaimsFromDocument(document_);
  const { readyToClaim, readyToClaimArp } = countBattlePassClaims(document_);

  const state: BattlePassState = {
    readyToClaim,
    readyToClaimArp,
    url,
    scrapedAt: new Date().toISOString(),
  };
  if (readyClaims.length > 0) {
    state.readyClaims = readyClaims;
  }

  if (tokensMatch?.[1] && tokensMatch[2]) {
    state.tokens = Number(tokensMatch[1].replaceAll(',', ''));
    state.tokensMax = Number(tokensMatch[2].replaceAll(',', ''));
  }
  const tokenCount = numberFromElement(
    document_,
    '.bp-header__token-count',
  );
  const tokenTotal = numberFromElement(
    document_,
    '.bp-header__token-total',
  );
  if (tokenCount !== undefined) {
    state.tokens = tokenCount;
  }
  if (tokenTotal !== undefined) {
    state.tokensMax = tokenTotal;
  }

  applyBattlePassEnd(state, document_);

  return state;
}

const BATTLE_PASS_ENDS_RE =
  /battle\s*pass\s*ends?\s*in\s*(\d{1,3}(?:\s*:\s*\d{1,2}){2,3})/i;

function numberFromElement(
  document_: Document,
  selector: string,
): number | undefined {
  const raw = document_.querySelector(selector)?.textContent?.replaceAll(',', '').trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  return Number(raw);
}

function battlePassEndsAtFromDocument(document_: Document): string | undefined {
  const raw = document_.querySelector<HTMLElement>(
      '.bp-header__countdown[data-countdown], .bp-widget__countdown[data-countdown]',
    )?.dataset.countdown?.trim();
  if (!raw) {
    return undefined;
  }
  const endsAt = Date.parse(raw);
  return Number.isNaN(endsAt) ? undefined : new Date(endsAt).toISOString();
}

function applyBattlePassEnd(state: BattlePassState, document_: Document): void {
  const absolute = battlePassEndsAtFromDocument(document_);
  if (absolute) {
    state.endsAt = absolute;
  }
  applyBattlePassCountdown(state, pageText(document_));
}

function applyBattlePassCountdown(state: BattlePassState, body: string): void {
  const endsMatch = BATTLE_PASS_ENDS_RE.exec(body);
  if (!endsMatch?.[1]) {
    return;
  }
  const raw = endsMatch[1].replaceAll(/\s+/g, ' ').trim();
  state.endsInText = raw;
  const remaining = parseBattlePassCountdownMs(raw);
  // `data-countdown` is an absolute timestamp. The visible clock is only a fallback.
  if (remaining !== undefined && !state.endsAt) {
    state.endsAt = new Date(Date.now() + remaining).toISOString();
  }
}

/**
 * `13 : 12 : 35 : 05` (d:h:m:s) or `12:35:05` (h:m:s).
 */
export function parseBattlePassCountdownMs(text: string): number | undefined {
  const parts = text
    .trim()
    .split(':')
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part));
  if (parts.length < 3 || parts.length > 4) {
    return undefined;
  }
  const seconds = parts.at(-1) ?? 0;
  const minutes = parts.at(-2) ?? 0;
  const hours = parts.at(-3) ?? 0;
  const days = parts.length === 4 ? (parts[0] ?? 0) : 0;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

export function battlePassRemainingMs(
  battlePass: BattlePassState | undefined,
  now = Date.now(),
): number | undefined {
  if (!battlePass) {
    return undefined;
  }
  if (battlePass.endsAt) {
    const endsAt = Date.parse(battlePass.endsAt);
    if (!Number.isNaN(endsAt)) {
      return Math.max(0, endsAt - now);
    }
  }
  if (!battlePass.endsInText || !battlePass.scrapedAt) {
    return undefined;
  }
  const parsed = parseBattlePassCountdownMs(battlePass.endsInText);
  const scrapedAt = Date.parse(battlePass.scrapedAt);
  return parsed === undefined || Number.isNaN(scrapedAt) ? undefined : Math.max(0, parsed - (now - scrapedAt));
}

export function mergeBattlePassScrape(
  scraped: BattlePassState,
  previous: BattlePassState | undefined,
): BattlePassState {
  const scrapedId = battlePassSeasonId(scraped.url);
  const previousId = battlePassSeasonId(previous?.url);
  // Visiting an ended pass must not replace the current season's ready claims.
  if (
    previous &&
    scrapedId !== undefined &&
    previousId !== undefined &&
    scrapedId < previousId
  ) {
    return previous;
  }
  if (scraped.endsAt || !previous?.endsAt) {
    return scraped;
  }
  const merged: BattlePassState = {
    ...scraped,
    endsAt: previous.endsAt,
  };
  if (!merged.endsInText && previous.endsInText) {
    merged.endsInText = previous.endsInText;
  }
  return merged;
}

export function applyBattlePassEndFromDocument(
  next: SiteState,
  document_: Document,
): void {
  if (!next.battlePass) {
    return;
  }
  const battlePass = { ...next.battlePass };
  applyBattlePassEnd(battlePass, document_);
  next.battlePass = battlePass;
}

/**
 * Battle Pass track popups use `.bp-popup__claim-btn` (often hidden until opened).
 * Free and premium tracks share one form action — count unique claim POSTs.
 */
function listReadyClaimsFromDocument(
  document_: Document,
): BattlePassReadyClaim[] {
  const claims: BattlePassReadyClaim[] = [];
  const popups = document_.querySelectorAll('.bp-popup[data-milestone-id]');
  for (const popup of popups) {
    if (!(popup instanceof HTMLElement)) {
      continue;
    }
    const milestoneId = popup.dataset.milestoneId ?? '';
    if (!milestoneId) {
      continue;
    }
    claims.push(...readyClaimsFromPopup(popup));
  }
  return uniqueReadyClaims(claims);
}

function readyClaimFromButton(
  button: HTMLElement,
  popup: HTMLElement,
): BattlePassReadyClaim {
  const form = button.closest('form');
  const claimPath = form?.getAttribute('action')?.trim() || undefined;
  const csrfToken = form
    ?.querySelector<HTMLInputElement>('input[name="_csrf_token"]')
    ?.value;
  const milestoneId =
    (form instanceof HTMLElement ? form.dataset.milestoneId : undefined) ??
    popup.dataset.milestoneId ??
    '';
  const claim: BattlePassReadyClaim = {
    milestoneId,
    isArp: isArpClaimPopup(popup),
  };
  if (claimPath) {
    claim.claimPath = claimPath;
  }
  if (csrfToken) {
    claim.csrfToken = csrfToken;
  }
  if (!claimPath) {
    claim.body = {
      ...datasetRecord(popup),
      ...datasetRecord(button),
    };
  }
  return claim;
}

function readyClaimsFromPopup(popup: HTMLElement): BattlePassReadyClaim[] {
  return [...popup.querySelectorAll('.bp-popup__claim-btn')].flatMap(
    (button) => {
      return (button instanceof HTMLElement) ? [readyClaimFromButton(button, popup)] : [];
    },
  );
}

function countBattlePassClaims(document_: Document): {
  readyToClaim: number;
  readyToClaimArp: number;
} {
  const readyClaims = listReadyClaimsFromDocument(document_);
  if (readyClaims.length > 0) {
    return {
      readyToClaim: readyClaims.length,
      readyToClaimArp: readyClaims.filter((claim) => claim.isArp).length,
    };
  }

  // Legacy / alternate copy.
  const legacy = (pageText(document_).match(/Ready to claim/gi) ?? []).length;
  return { readyToClaim: legacy, readyToClaimArp: legacy };
}

function isBattlePassArpRewardTitle(title: string): boolean {
  if (/ARP\s*Boost/i.test(title)) {
    return true;
  }
  // e.g. "40 ARP" but not "25 ARP Required" (requirement line, not reward title).
  return /^\d[\d,]*\s*ARP$/i.test(title.trim());
}

function battlePassPopupTitle(popup: HTMLElement): string {
  return popup.querySelector('.bp-popup__title')?.textContent?.trim() ?? '';
}

function isArpClaimPopup(popup: HTMLElement): boolean {
  return isBattlePassArpRewardTitle(battlePassPopupTitle(popup));
}

function claimIdentity(claim: BattlePassReadyClaim): string {
  return claim.claimPath ?? claim.milestoneId;
}

function uniqueReadyClaims(
  claims: BattlePassReadyClaim[],
): BattlePassReadyClaim[] {
  const seen = new Set<string>();
  const unique: BattlePassReadyClaim[] = [];
  for (const claim of claims) {
    const key = claimIdentity(claim);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(claim);
  }
  return unique;
}

function claimButtonIdentity(button: HTMLElement, popup: HTMLElement): string {
  const form = button.closest('form');
  return form?.getAttribute('action')?.trim() || popup.dataset.milestoneId || '';
}

function pushUniqueClaimButton(
  items: { button: HTMLElement; popup: HTMLElement }[],
  seen: Set<string>,
  button: Element,
  popup: HTMLElement,
): void {
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const key = claimButtonIdentity(button, popup);
  if (!key || seen.has(key)) {
    return;
  }
  seen.add(key);
  items.push({ button, popup });
}

export function listBattlePassClaimButtons(
  document_: Document = document,
  options: { shouldSkipArpBoosts?: boolean } = {},
): { button: HTMLElement; popup: HTMLElement }[] {
  const shouldSkipArpBoosts = options.shouldSkipArpBoosts === true;
  const popups = document_.querySelectorAll('.bp-popup[data-milestone-id]');
  const items: { button: HTMLElement; popup: HTMLElement }[] = [];
  const seen = new Set<string>();
  for (const popup of popups) {
    if (!(popup instanceof HTMLElement)) {
      continue;
    }
    if (shouldSkipArpBoosts && isArpClaimPopup(popup)) {
      continue;
    }
    for (const button of popup.querySelectorAll('.bp-popup__claim-btn')) {
      pushUniqueClaimButton(items, seen, button, popup);
    }
  }
  return items;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Gap between Battle Pass claim POSTs. Claiming several in one burst has
 * triggered a site-side bug for other users.
 */
const CLAIM_QUEUE_GAP_MS = 1500;

async function waitWhile(
  isWaiting: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const startedAt = Date.now();
  while (isWaiting() && Date.now() - startedAt < timeoutMs) {
    await delay(intervalMs);
  }
}

interface BattlePassClaimEndpoint {
  path: string;
  hasIdInPath: boolean;
  idParameter: string;
}

const claimEndpointCache: { value?: BattlePassClaimEndpoint } = {};

function jsonishId(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value;
}

function datasetRecord(element: HTMLElement): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element.dataset)) {
    if (value === undefined || value === '') {
      continue;
    }
    record[key] = jsonishId(value);
  }
  return record;
}

function isBattlePassClaimPath(path: string): boolean {
  const normalized = path.toLowerCase();
  if (
    /giveaway|marketplace|ucf\/show|community-giveaway|vote\//.test(normalized)
  ) {
    return false;
  }
  const hasClaim = /claim/.test(normalized);
  const hasBattlePass = /battle-?pass/.test(normalized);
  const hasMilestone = /milestone/.test(normalized);
  return hasClaim && (hasBattlePass || hasMilestone);
}

function endpointFromHref(raw: string): BattlePassClaimEndpoint | undefined {
  let path = raw.trim();
  try {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) {
      return undefined;
    }
    path = `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
  if (!isBattlePassClaimPath(path)) {
    return undefined;
  }
  const hasIdInPath = /\/\d+\/?$/.test(urlPathname(path));
  return {
    path: hasIdInPath ? path.replace(/\/\d+\/?$/, '') : path,
    hasIdInPath,
    idParameter: 'milestoneId',
  };
}

function urlPathname(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

function firstClaimEndpoint(
  candidates: (string | undefined)[],
): BattlePassClaimEndpoint | undefined {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const endpoint = endpointFromHref(candidate);
    if (endpoint) {
      return endpoint;
    }
  }
  return undefined;
}

function endpointFromClaimMarkup(
  document_: Document,
): BattlePassClaimEndpoint | undefined {
  for (const item of listBattlePassClaimButtons(document_)) {
    const endpoint = firstClaimEndpoint([
      item.button.closest('form')?.getAttribute('action') ?? undefined,
      item.button.getAttribute('href') ?? undefined,
      item.button.getAttribute('formaction') ?? undefined,
      item.button.dataset.url,
      item.button.dataset.href,
      item.button.dataset.action,
      item.popup.dataset.url,
      item.popup.dataset.href,
      item.popup.dataset.claimUrl,
    ]);
    if (endpoint) {
      return endpoint;
    }
  }
  return undefined;
}

function idParameterFromSource(source: string): string {
  const match = /(?:milestoneId|milestone_id|rewardId)\s*:/i.exec(source);
  return /rewardId/i.test(match?.[0] ?? '') ? 'rewardId' : 'milestoneId';
}

function endpointFromQuotedPath(
  path: string,
  source: string,
  hasIdInPathHint = false,
): BattlePassClaimEndpoint | undefined {
  if (!isBattlePassClaimPath(path)) {
    return undefined;
  }
  const hasIdInPath =
    hasIdInPathHint ||
    /\/\d+\/?$/.test(urlPathname(path)) ||
    /\$\{|\{id\}|\{milestone/i.test(path);
  return {
    path: hasIdInPath ? path.replace(/\/\d+\/?$/, '').replace(/\/$/, '') : path,
    hasIdInPath,
    idParameter: idParameterFromSource(source),
  };
}

function endpointFromScripts(source: string): BattlePassClaimEndpoint | undefined {
  const concat =
    /['"](\/[^'"]*(?:claim[^'"]*(?:battle|milestone)|(?:battle-pass|milestone)[^'"]*claim)[^'"]*)['"]\s*\+/i.exec(
      source,
    );
  if (concat?.[1]) {
    const fromConcat = endpointFromQuotedPath(concat[1], source, true);
    if (fromConcat) {
      return fromConcat;
    }
  }
  const quotedPath =
    /['"](\/[^'"]*(?:claim[^'"]*(?:battle|milestone)|(?:battle-pass|milestone)[^'"]*claim)[^'"]*)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = quotedPath.exec(source))) {
    const endpoint = endpointFromQuotedPath(match[1] ?? '', source);
    if (endpoint) {
      return endpoint;
    }
  }
  const ajaxPath =
    /(?:\.post|\.ajax|fetch)\(\s*['"](\/[^'"]+)['"]/gi;
  while ((match = ajaxPath.exec(source))) {
    const endpoint = endpointFromQuotedPath(match[1] ?? '', source);
    if (endpoint) {
      return endpoint;
    }
  }
  return undefined;
}

function collectInlineScriptText(document_: Document): string {
  return [...document_.querySelectorAll('script:not([src])')]
    .map((script) => script.textContent ?? '')
    .join('\n');
}

function pageScriptUrls(document_: Document): string[] {
  const urls: string[] = [];
  const add = (raw: string | null): void => {
    if (!raw) {
      return;
    }
    try {
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin) {
        return;
      }
      urls.push(url.href);
    } catch {
      // Ignore malformed script URLs.
    }
  };
  for (const script of document_.querySelectorAll('script[src]')) {
    add(script.getAttribute('src'));
  }
  for (const link of document_.querySelectorAll(
    'link[rel="preload"][as="script"], link[as="script"]',
  )) {
    add(link.getAttribute('href'));
  }
  return [...new Set(urls)]
    .filter(
      (href) =>
        !/jquery|bootstrap|gtag|gtm|recaptcha|cloudflare|analytics|hotjar|sentry/i.test(
          href,
        ),
    )
    .slice(0, 24);
}

interface JQueryEventBag {
  click?: { handler?: (...arguments_: unknown[]) => unknown }[];
}

function endpointFromJquery(
  document_: Document,
): BattlePassClaimEndpoint | undefined {
  const view = document_.defaultView as
    | (Window & {
        jQuery?: {
          _data?: (element: EventTarget, key: string) => unknown;
        };
      })
    | null;
  const readEvents = view?.jQuery?._data;
  if (typeof readEvents !== 'function') {
    return undefined;
  }
  const roots: EventTarget[] = [
    ...document_.querySelectorAll('.bp-popup__claim-btn'),
    document_,
  ];
  if (document_.body) {
    roots.push(document_.body);
  }
  for (const root of roots) {
    const events = readEvents(root, 'events') as JQueryEventBag | undefined;
    const handlers = events?.click ?? [];
    const source = handlers
      .map((entry) => String(entry.handler ?? ''))
      .join('\n');
    const found = endpointFromScripts(source);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function endpointFromPageScripts(
  document_: Document,
): Promise<BattlePassClaimEndpoint | undefined> {
  for (const href of pageScriptUrls(document_)) {
    try {
      const response = await fetch(href);
      const text = await response.text();
      const handlerAt = text.search(/bp-popup__claim-btn|claim-btn/i);
      const fromFile =
        handlerAt >= 0
          ? (endpointFromScripts(
              text.slice(Math.max(0, handlerAt - 2000), handlerAt + 4000),
            ) ?? endpointFromScripts(text))
          : endpointFromScripts(text);
      if (fromFile) {
        return fromFile;
      }
    } catch {
      // Same-origin script fetch can fail on hashed chunks; keep looking.
    }
  }
  return undefined;
}

async function fetchBattlePassDocument(
  path?: string,
): Promise<Document | undefined> {
  const resolved =
    path ??
    (await discoverBattlePassPath({
      knownUrl: battlePassControlCenterPath(globalThis.location?.pathname),
    }));
  if (!resolved) {
    return undefined;
  }
  try {
    const response = await fetch(resolved, {
      headers: { Accept: 'text/html' },
    });
    return response.ok ? new DOMParser().parseFromString(await response.text(), 'text/html') : undefined;
  } catch {
    return undefined;
  }
}

function cacheClaimEndpoint(
  endpoint: BattlePassClaimEndpoint,
): BattlePassClaimEndpoint {
  claimEndpointCache.value = endpoint;
  console.info(
    '[AWA Toolkit] Battle Pass claim POST',
    endpoint.path,
    endpoint.hasIdInPath ? '(id in path)' : '',
  );
  return endpoint;
}

async function searchDocumentForClaimEndpoint(
  document_: Document,
): Promise<BattlePassClaimEndpoint | undefined> {
  return (
    endpointFromClaimMarkup(document_) ??
    endpointFromScripts(collectInlineScriptText(document_)) ??
    endpointFromJquery(document_) ??
    (await endpointFromPageScripts(document_))
  );
}

async function discoverBattlePassClaimEndpoint(
  document_?: Document,
): Promise<BattlePassClaimEndpoint | undefined> {
  if (claimEndpointCache.value) {
    return claimEndpointCache.value;
  }
  if (document_) {
    const found = await searchDocumentForClaimEndpoint(document_);
    if (found) {
      return cacheClaimEndpoint(found);
    }
  }
  const isOnBattlePassPage = location.pathname.includes('/battle-pass');
  const hasSearchedFetchedPage = Boolean(document_ && document_ !== document);
  if (!isOnBattlePassPage && !hasSearchedFetchedPage) {
    const fetched = await fetchBattlePassDocument();
    if (fetched) {
      const found = await searchDocumentForClaimEndpoint(fetched);
      if (found) {
        return cacheClaimEndpoint(found);
      }
    }
  }
  return undefined;
}

function resolveClaimPath(
  endpoint: BattlePassClaimEndpoint,
  milestoneId: string,
): string {
  if (!endpoint.hasIdInPath) {
    return endpoint.path;
  }
  const trimmed = endpoint.path.replace(/\/$/, '');
  return trimmed.endsWith(`/${milestoneId}`) ? trimmed : `${trimmed}/${milestoneId}`;
}

function resolveClaimBody(
  endpoint: BattlePassClaimEndpoint | undefined,
  claim: BattlePassReadyClaim,
): Record<string, unknown> {
  if (claim.csrfToken) {
    return { _csrf_token: claim.csrfToken };
  }
  const body: Record<string, unknown> = { ...claim.body };
  if (endpoint && body[endpoint.idParameter] === undefined) {
    body[endpoint.idParameter] = jsonishId(claim.milestoneId);
  }
  return body;
}

function claimKey(claim: BattlePassReadyClaim): string {
  return claimIdentity(claim);
}

function claimPostPath(
  claim: BattlePassReadyClaim,
  endpoint: BattlePassClaimEndpoint | undefined,
): string | undefined {
  if (claim.claimPath) {
    return claim.claimPath;
  }
  return endpoint && claim.milestoneId ? resolveClaimPath(endpoint, claim.milestoneId) : undefined;
}

async function claimReadyViaApi(
  claims: BattlePassReadyClaim[],
  endpoint: BattlePassClaimEndpoint | undefined,
): Promise<{ claimed: number; postedPaths: Set<string> }> {
  const seen = new Set<string>();
  const postedPaths = new Set<string>();
  let claimed = 0;
  let hasPosted = false;
  for (const claim of uniqueReadyClaims(claims)) {
    const path = claimPostPath(claim, endpoint);
    const key = claimKey(claim);
    if (!path || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (hasPosted) {
      await delay(CLAIM_QUEUE_GAP_MS);
    }
    hasPosted = true;
    const result = await claimBattlePassReward(
      path,
      resolveClaimBody(endpoint, claim),
    );
    postedPaths.add(path);
    if (!result.ok) {
      continue;
    }
    claimed += 1;
  }
  return { claimed, postedPaths };
}

function claimsFromLiveButtons(
  items: { button: HTMLElement; popup: HTMLElement }[],
): BattlePassReadyClaim[] {
  return uniqueReadyClaims(
    items.map((item) => readyClaimFromButton(item.button, item.popup)),
  );
}

async function clickRemainingClaimButtons(
  document_: Document,
  options: {
    shouldSkipArpBoosts?: boolean;
    skipPaths?: Set<string>;
  } = {},
): Promise<number> {
  const attempted = new WeakSet<HTMLElement>();
  const skipPaths = options.skipPaths ?? new Set<string>();
  let claimed = 0;
  let hasClicked = false;
  while (claimed < 40) {
    const next = listBattlePassClaimButtons(document_, options).find(
      (item) => {
        if (!item.button.isConnected || attempted.has(item.button)) {
          return false;
        }
        const path = claimButtonIdentity(item.button, item.popup);
        return !path || !skipPaths.has(path);
      },
    );
    if (!next) {
      break;
    }
    attempted.add(next.button);
    const { button, popup } = next;
    const path = claimButtonIdentity(button, popup);
    if (path) {
      skipPaths.add(path);
    }
    if (hasClicked) {
      await delay(CLAIM_QUEUE_GAP_MS);
    }
    hasClicked = true;
    if (button.offsetParent === null) {
      popup.click();
      await delay(250);
    }
    button.click();
    await waitWhile(() => button.isConnected && popup.contains(button), 4000);
    if (!button.isConnected || !popup.contains(button)) {
      claimed += 1;
    }
  }
  return claimed;
}

async function waitForBattlePassClaimButtons(
  document_: Document,
  options: { shouldSkipArpBoosts?: boolean } = {},
  timeoutMs = 8000,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const count = listBattlePassClaimButtons(document_, options).length;
    if (count > 0) {
      return count;
    }
    await delay(250);
  }
  return listBattlePassClaimButtons(document_, options).length;
}

/**
 * Claim ready Battle Pass rewards with the site's same-origin form POST
 * (`/battle-pass/claim/{instanceId}` + `_csrf_token`). From Control Center,
 * fetch the Battle Pass HTML for those forms — do not open the BP page.
 */
export async function claimAllBattlePassRewards(
  options: {
    shouldSkipArpBoosts?: boolean;
    readyClaims?: BattlePassReadyClaim[];
    battlePassPath?: string;
  } = {},
): Promise<{
  claimed: number;
  remaining: number;
  needsBattlePassPage?: boolean;
}> {
  const shouldSkipArpBoosts = options.shouldSkipArpBoosts === true;
  const isOnBattlePassPage = location.pathname.includes('/battle-pass');
  if (isOnBattlePassPage) {
    await waitForBattlePassClaimButtons(document, { shouldSkipArpBoosts });
  }

  const liveDocument = isOnBattlePassPage ? document : undefined;
  let fetchedDocument: Document | undefined;
  let targets: BattlePassReadyClaim[];
  if (isOnBattlePassPage) {
    targets = claimsFromLiveButtons(
      listBattlePassClaimButtons(document, { shouldSkipArpBoosts }),
    );
  } else {
    const path = await discoverBattlePassPath({
      knownUrl: options.battlePassPath,
    });
    fetchedDocument = await fetchBattlePassDocument(path);
    targets = fetchedDocument
      ? listReadyClaimsFromDocument(fetchedDocument).filter(
          (claim) => !shouldSkipArpBoosts || !claim.isArp,
        )
      : [];
    if (targets.every((claim) => !claim.claimPath)) {
      targets = (options.readyClaims ?? []).filter(
        (claim) =>
          Boolean(claim.claimPath) &&
          (!shouldSkipArpBoosts || !claim.isArp),
      );
    }
  }

  const endpoint = await discoverBattlePassClaimEndpoint(
    liveDocument ?? fetchedDocument,
  );
  const posted =
    targets.length > 0
      ? await claimReadyViaApi(targets, endpoint)
      : { claimed: 0, postedPaths: new Set<string>() };
  let claimed = posted.claimed;

  if (isOnBattlePassPage) {
    await waitWhile(
      () => listBattlePassClaimButtons(document, { shouldSkipArpBoosts }).length > 0,
      1500,
    );
    let remaining = listBattlePassClaimButtons(document, {
      shouldSkipArpBoosts,
    }).length;
    if (remaining > 0) {
      claimed += await clickRemainingClaimButtons(document, {
        shouldSkipArpBoosts,
        skipPaths: posted.postedPaths,
      });
      await waitWhile(
        () =>
          listBattlePassClaimButtons(document, { shouldSkipArpBoosts }).length >
          0,
        1500,
      );
      remaining = listBattlePassClaimButtons(document, {
        shouldSkipArpBoosts,
      }).length;
    }
    return { claimed, remaining };
  }

  const uniqueTargets = new Set(
    targets.map((claim) => claimIdentity(claim)),
  ).size;
  return {
    claimed,
    remaining: Math.max(0, uniqueTargets - claimed),
  };
}

/**
Claimable Battle Pass ARP that All-ARP% multiplies.
*/
export function battlePassClaimableArp(
  battlePass: BattlePassState | undefined,
): number {
  return battlePass?.readyToClaimArp ?? 0;
}

export function battlePassReadyNonArp(
  battlePass: BattlePassState | undefined,
): number {
  const ready = battlePass?.readyToClaim ?? 0;
  return Math.max(0, ready - battlePassClaimableArp(battlePass));
}

/**
 * True while ARP Boosts should stay unclaimed until All-ARP% is equipped.
 */
export function shouldSkipArpInBattlePassClaimAll(
  battlePass: BattlePassState | undefined,
  shouldWaitForAllArpSwap: boolean,
): boolean {
  return shouldWaitForAllArpSwap && battlePassClaimableArp(battlePass) > 0;
}

/**
 * Claim is offered when something is ready, except ARP-only while waiting
 * for an All-ARP% swap. Non-ARP rewards can still be claimed in that wait.
 */
export function shouldShowBattlePassClaimAll(
  battlePass: BattlePassState | undefined,
  shouldWaitForAllArpSwap: boolean,
): boolean {
  if (battlePassReadyNonArp(battlePass) > 0) {
    return true;
  }
  const ready = battlePass?.readyToClaim ?? 0;
  return ready > 0 && !shouldWaitForAllArpSwap;
}

/**
 * Skip-ARP must not say "all" — that implies claiming the boosts we are holding.
 */
export function battlePassClaimButtonLabel(
  shouldSkipArpBoosts: boolean,
  options?: { compact?: boolean },
): string {
  if (shouldSkipArpBoosts) {
    return 'Claim rewards';
  }
  return options?.compact === true ? 'Claim all BP' : 'Claim all';
}

export function scrapeBattlePass(): BattlePassState | undefined {
  return location.pathname.includes('/battle-pass')
    ? scrapeBattlePassFromDocument(document, location.pathname)
    : undefined;
}

export function isBattlePassDocumentReady(document_: Document): boolean {
  return Boolean(
    document_.querySelector(
      '.bp-popup[data-milestone-id], .bp-popup__claim-btn, .bp-popup__claimed',
    ) || /Ready to claim/i.test(document_.body?.textContent ?? ''),
  );
}

export async function waitForBattlePassDocument(
  timeoutMs = 12_000,
): Promise<void> {
  if (isBattlePassDocumentReady(document)) {
    return;
  }
  await new Promise<void>((resolve) => {
    let isSettled = false;
    const observer = new MutationObserver(() => {
      if (isBattlePassDocumentReady(document)) {
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

/**
 * Claim buttons are removed and `.bp-popup__claimed` appears after a successful
 * claim. Persist ready counts whenever that DOM changes so CC / optimizer
 * don't keep stale "claim N boosts" todos.
 */
export function battlePassClaimSignature(document_: Document): string {
  const { readyToClaim, readyToClaimArp } = countBattlePassClaims(document_);
  return `${readyToClaim}:${readyToClaimArp}`;
}
