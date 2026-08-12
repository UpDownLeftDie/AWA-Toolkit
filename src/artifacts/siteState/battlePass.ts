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
 * Dedupes free/premium duplicate popups by milestone id.
 */
function countBattlePassClaims(document_: Document): {
  readyToClaim: number;
  readyToClaimArp: number;
} {
  const popups = document_.querySelectorAll('.bp-popup[data-milestone-id]');
  if (popups.length > 0) {
    const seen = new Set<string>();
    let readyToClaim = 0;
    let readyToClaimArp = 0;
    for (const popup of popups) {
      if (!(popup instanceof HTMLElement)) {
        continue;
      }
      const id = popup.dataset.milestoneId ?? '';
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      if (!popup.querySelector('.bp-popup__claim-btn')) {
        continue;
      }
      readyToClaim += 1;
      const title =
        popup.querySelector('.bp-popup__title')?.textContent?.trim() ?? '';
      if (isBattlePassArpRewardTitle(title)) {
        readyToClaimArp += 1;
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

/**
Claimable Battle Pass ARP that All-ARP% multiplies.
*/
export function battlePassClaimableArp(
  battlePass: BattlePassState | undefined,
): number {
  return battlePass?.readyToClaimArp ?? 0;
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
