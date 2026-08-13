import { claimBattlePassReward } from '../api';
import { pageText } from './shared';
import type { SiteState } from './types';

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
  endsInText?: string;
  /**
  Absolute end from the on-page countdown at scrape time (not a 24h slot lock).
  */
  endsAt?: string;
  url: string;
  scrapedAt: string;
}

export function scrapeBattlePassFromDocument(
  document_: Document,
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

  const { readyToClaim, readyToClaimArp } = countBattlePassClaims(document_);

  const state: BattlePassState = {
    readyToClaim,
    readyToClaimArp,
    url: '/control-center/battle-pass/1',
    scrapedAt: new Date().toISOString(),
  };

  if (tokensMatch?.[1] && tokensMatch[2]) {
    state.tokens = Number(tokensMatch[1].replaceAll(',', ''));
    state.tokensMax = Number(tokensMatch[2].replaceAll(',', ''));
  }

  applyBattlePassCountdown(state, body);

  return state;
}

const BATTLE_PASS_ENDS_RE =
  /battle\s*pass\s*ends?\s*in\s*(\d{1,3}(?:\s*:\s*\d{1,2}){2,3})/i;

function applyBattlePassCountdown(state: BattlePassState, body: string): void {
  const endsMatch = BATTLE_PASS_ENDS_RE.exec(body);
  if (!endsMatch?.[1]) {
    return;
  }
  const raw = endsMatch[1].replaceAll(/\s+/g, ' ').trim();
  state.endsInText = raw;
  const remaining = parseBattlePassCountdownMs(raw);
  if (remaining !== undefined) {
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
  if (parsed === undefined || Number.isNaN(scrapedAt)) {
    return undefined;
  }
  return Math.max(0, parsed - (now - scrapedAt));
}

export function mergeBattlePassScrape(
  scraped: BattlePassState,
  previous: BattlePassState | undefined,
): BattlePassState {
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
  applyBattlePassCountdown(battlePass, pageText(document_));
  next.battlePass = battlePass;
}

/**
 * Battle Pass track popups use `.bp-popup__claim-btn` (often hidden until opened).
 * Free and premium tracks can share a milestone id — count each popup.
 */
function countBattlePassClaims(document_: Document): {
  readyToClaim: number;
  readyToClaimArp: number;
} {
  const popups = document_.querySelectorAll('.bp-popup[data-milestone-id]');
  if (popups.length > 0) {
    let readyToClaim = 0;
    let readyToClaimArp = 0;
    for (const popup of popups) {
      if (!(popup instanceof HTMLElement)) {
        continue;
      }
      const claimCount = popup.querySelectorAll('.bp-popup__claim-btn').length;
      if (claimCount === 0) {
        continue;
      }
      readyToClaim += claimCount;
      const title =
        popup.querySelector('.bp-popup__title')?.textContent?.trim() ?? '';
      if (isBattlePassArpRewardTitle(title)) {
        readyToClaimArp += claimCount;
      }
    }
    return { readyToClaim, readyToClaimArp };
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

export function listBattlePassClaimButtons(
  document_: Document = document,
  options: { shouldSkipArpBoosts?: boolean } = {},
): { button: HTMLElement; popup: HTMLElement }[] {
  const shouldSkipArpBoosts = options.shouldSkipArpBoosts === true;
  const popups = document_.querySelectorAll('.bp-popup[data-milestone-id]');
  const items: { button: HTMLElement; popup: HTMLElement }[] = [];
  for (const popup of popups) {
    if (!(popup instanceof HTMLElement)) {
      continue;
    }
    if (shouldSkipArpBoosts && isArpClaimPopup(popup)) {
      continue;
    }
    for (const button of popup.querySelectorAll('.bp-popup__claim-btn')) {
      if (button instanceof HTMLElement) {
        items.push({ button, popup });
      }
    }
  }
  return items;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
  if (!/battle-pass/i.test(path) || !/claim/i.test(path)) {
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

function endpointFromScripts(source: string): BattlePassClaimEndpoint | undefined {
  const concat =
    /['"](\/(?:control-center\/)?battle-pass\/[^'"]*claim[^'"]*)['"]\s*\+/i.exec(
      source,
    );
  if (concat?.[1]) {
    return {
      path: concat[1].replace(/\/$/, ''),
      hasIdInPath: true,
      idParameter: 'milestoneId',
    };
  }
  const quoted =
    /['"](\/(?:control-center\/)?battle-pass\/[^'"]*claim[^'"]*)['"]/i.exec(
      source,
    );
  if (!quoted?.[1]) {
    return undefined;
  }
  const path = quoted[1];
  const hasIdInPath =
    /\/\d+\/?$/.test(urlPathname(path)) ||
    /\$\{|\{id\}|\{milestone/i.test(path);
  const parameterMatch = /(?:milestoneId|milestone_id|rewardId)\s*:/i.exec(
    source,
  );
  const idParameter = /rewardId/i.test(parameterMatch?.[0] ?? '')
    ? 'rewardId'
    : 'milestoneId';
  return {
    path: hasIdInPath ? path.replace(/\/\d+\/?$/, '').replace(/\/$/, '') : path,
    hasIdInPath,
    idParameter,
  };
}

function collectInlineScriptText(document_: Document): string {
  return [...document_.querySelectorAll('script:not([src])')]
    .map((script) => script.textContent ?? '')
    .join('\n');
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

async function discoverBattlePassClaimEndpoint(
  document_: Document,
): Promise<BattlePassClaimEndpoint | undefined> {
  if (claimEndpointCache.value) {
    return claimEndpointCache.value;
  }
  const found =
    endpointFromClaimMarkup(document_) ??
    endpointFromScripts(collectInlineScriptText(document_)) ??
    endpointFromJquery(document_);
  if (found) {
    claimEndpointCache.value = found;
    return found;
  }
  const sources = [...document_.querySelectorAll('script[src]')]
    .map((script) => script.getAttribute('src'))
    .filter((source): source is string => Boolean(source))
    .filter((source) => /battle|pass|control-center|app|main|site/i.test(source))
    .slice(0, 8);
  for (const source of sources) {
    try {
      const url = new URL(source, location.origin);
      if (url.origin !== location.origin) {
        continue;
      }
      const response = await fetch(url.href);
      const text = await response.text();
      const fromFile = endpointFromScripts(text);
      if (fromFile) {
        claimEndpointCache.value = fromFile;
        return fromFile;
      }
    } catch {
      // Same-origin script fetch can fail on hashed chunks; keep looking.
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
  if (trimmed.endsWith(`/${milestoneId}`)) {
    return trimmed;
  }
  return `${trimmed}/${milestoneId}`;
}

function resolveClaimBody(
  endpoint: BattlePassClaimEndpoint,
  popup: HTMLElement,
  button: HTMLElement,
): Record<string, unknown> {
  const body = {
    ...datasetRecord(popup),
    ...datasetRecord(button),
  };
  const milestoneId = popup.dataset.milestoneId;
  if (milestoneId && body[endpoint.idParameter] === undefined) {
    body[endpoint.idParameter] = jsonishId(milestoneId);
  }
  return body;
}

async function claimTargetsViaApi(
  document_: Document,
  items: { button: HTMLElement; popup: HTMLElement }[],
): Promise<number> {
  const endpoint = await discoverBattlePassClaimEndpoint(document_);
  if (!endpoint) {
    return 0;
  }
  const seen = new Set<string>();
  let claimed = 0;
  for (const item of items) {
    const milestoneId = item.popup.dataset.milestoneId ?? '';
    const key = `${milestoneId}:${JSON.stringify(datasetRecord(item.popup))}`;
    if (!milestoneId || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const result = await claimBattlePassReward(
      resolveClaimPath(endpoint, milestoneId),
      resolveClaimBody(endpoint, item.popup, item.button),
    );
    if (!result.ok) {
      continue;
    }
    claimed += 1;
    await delay(200);
  }
  return claimed;
}

async function clickRemainingClaimButtons(
  document_: Document,
  options: { shouldSkipArpBoosts?: boolean } = {},
): Promise<number> {
  const attempted = new WeakSet<HTMLElement>();
  let claimed = 0;
  while (claimed < 40) {
    const next = listBattlePassClaimButtons(document_, options).find(
      (item) => item.button.isConnected && !attempted.has(item.button),
    );
    if (!next) {
      break;
    }
    attempted.add(next.button);
    const { button, popup } = next;
    button.click();
    claimed += 1;
    await waitWhile(() => button.isConnected && popup.contains(button), 4000);
    await delay(200);
  }
  return claimed;
}

const BATTLE_PASS_PATH = '/control-center/battle-pass/1';

async function openHiddenBattlePassFrame(): Promise<HTMLIFrameElement | undefined> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;width:1px;height:1px;left:-9999px;top:0;opacity:0;pointer-events:none;border:0';
    const finish = (frame: HTMLIFrameElement | undefined): void => {
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
      resolve(frame);
    };
    const timer = setTimeout(() => {
      iframe.remove();
      finish(undefined);
    }, 15_000);
    const onError = (): void => {
      clearTimeout(timer);
      iframe.remove();
      finish(undefined);
    };
    const onLoad = (): void => {
      clearTimeout(timer);
      void (async () => {
        const document_ = iframe.contentDocument;
        if (!document_) {
          iframe.remove();
          finish(undefined);
          return;
        }
        const started = Date.now();
        while (
          Date.now() - started < 8000 &&
          !isBattlePassDocumentReady(document_)
        ) {
          await delay(250);
        }
        finish(iframe);
      })();
    };
    iframe.addEventListener('load', onLoad);
    iframe.addEventListener('error', onError);
    document.body.append(iframe);
    iframe.src = BATTLE_PASS_PATH;
  });
}

async function claimOnDocument(
  document_: Document,
  options: { shouldSkipArpBoosts?: boolean } = {},
): Promise<{
  claimed: number;
  remaining: number;
}> {
  const items = listBattlePassClaimButtons(document_, options);
  const viaApi = await claimTargetsViaApi(document_, items);
  await waitWhile(
    () => listBattlePassClaimButtons(document_, options).length > 0,
    2000,
  );
  let remaining = listBattlePassClaimButtons(document_, options).length;
  let viaClick = 0;
  if (remaining > 0) {
    viaClick = await clickRemainingClaimButtons(document_, options);
    await waitWhile(
      () => listBattlePassClaimButtons(document_, options).length > 0,
      1500,
    );
    remaining = listBattlePassClaimButtons(document_, options).length;
  }
  return {
    claimed: viaApi + viaClick,
    remaining,
  };
}

/**
 * Claim ready Battle Pass rewards. Prefers the site's claim POST (same style
 * as artifact equip); clicks CLAIM buttons if the route isn't in the page JS.
 * `shouldSkipArpBoosts` leaves ARP Boosts unclaimed (All-ARP% wait).
 * Off the Battle Pass page, loads it in a hidden iframe first.
 */
export async function claimAllBattlePassRewards(
  options: { shouldSkipArpBoosts?: boolean } = {},
): Promise<{
  claimed: number;
  remaining: number;
  needsBattlePassPage?: boolean;
}> {
  if (location.pathname.includes('/battle-pass')) {
    return claimOnDocument(document, options);
  }
  const frame = await openHiddenBattlePassFrame();
  const document_ = frame?.contentDocument;
  if (!document_ || !isBattlePassDocumentReady(document_)) {
    frame?.remove();
    return { claimed: 0, remaining: 0, needsBattlePassPage: true };
  }
  try {
    return await claimOnDocument(document_, options);
  } finally {
    frame.remove();
  }
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
 * Claim all is offered when something is ready, except ARP-only while waiting
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

export function scrapeBattlePass(): BattlePassState | undefined {
  if (!location.pathname.includes('/battle-pass')) {
    return undefined;
  }
  return scrapeBattlePassFromDocument(document);
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
