/**
 * AWA dumps account state on the page `window` (`arp_tier`, `fragment_balance`,
 * `giveawayKeys`, …). This userscript is sandboxed (`@grant` ≠ none), so
 * `globalThis.arp_tier` is not that object — Tampermonkey/Violentmonkey expose
 * it as `unsafeWindow`.
 *
 * Chrome extensions have no `unsafeWindow`; Megumin injects a page `<script>`
 * instead. Do not copy that here: inline injects are subject to AWA's CSP.
 * `unsafeWindow` is the userscript equivalent.
 */
import { unsafeWindow } from '$';

export interface GiveawayKeyStatus {
  giveawayId: string;
  status: string;
  remaining?: number;
}

type PageWindow = Window & {
  arp_tier?: unknown;
  arp_balance?: unknown;
  arp_lifetime?: unknown;
  fragment_balance?: unknown;
  user_arp?: unknown;
  arp_points?: unknown;
  redeemable_arp?: unknown;
  giveawayKeys?: unknown;
  user_username?: unknown;
};

function pageWindow(): PageWindow {
  try {
    return unsafeWindow as PageWindow;
  } catch {
    // Tampermonkey throws if the page context is gone.
  }
  return globalThis as unknown as PageWindow;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replaceAll(',', ''));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function readPageNumber(name: keyof PageWindow): number | undefined {
  try {
    return asFiniteNumber(pageWindow()[name]);
  } catch {
    return undefined;
  }
}

export function parseInlineNumber(
  document_: Document,
  names: readonly string[],
): number | undefined {
  const pattern = new RegExp(
    String.raw`(?:var\s+|window\.)?(?:${names.join('|')})\s*=\s*(\d+)`,
  );
  for (const script of document_.querySelectorAll('script')) {
    const match = pattern.exec(script.textContent ?? '');
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return undefined;
}

export function readPageArpTier(
  document_: Document = document,
): number | undefined {
  if (document_ === document) {
    const tier = readPageNumber('arp_tier');
    if (tier !== undefined && tier >= 0) {
      return tier;
    }
  }
  const fromScript = parseInlineNumber(document_, ['arp_tier']);
  if (fromScript !== undefined) {
    return fromScript;
  }
  const tierImg = document_.querySelector<HTMLImageElement>(
    'img[src*="/images/content/tier-tags/"]',
  );
  const tierMatch = /tier-tags\/(\d+)\.png/.exec(tierImg?.src ?? '');
  if (!tierMatch?.[1]) {
    return undefined;
  }
  const tier = Number(tierMatch[1]);
  return Number.isFinite(tier) ? tier : undefined;
}

export function readPageFragmentBalance(
  document_: Document = document,
): number | undefined {
  if (document_ === document) {
    const fragments = readPageNumber('fragment_balance');
    if (fragments !== undefined && fragments >= 0) {
      return fragments;
    }
  }
  const fromScript = parseInlineNumber(document_, ['fragment_balance']);
  return fromScript !== undefined && fromScript >= 0 ? fromScript : undefined;
}

export function readPageRedeemableArp(
  document_: Document = document,
): number | undefined {
  const names = [
    'arp_balance',
    'user_arp',
    'arp_points',
    'redeemable_arp',
  ] as const;
  if (document_ === document) {
    for (const name of names) {
      const value = readPageNumber(name);
      if (value !== undefined && value >= 0) {
        return value;
      }
    }
  }
  const fromScript = parseInlineNumber(document_, names);
  return fromScript !== undefined && fromScript >= 0 ? fromScript : undefined;
}

function giveawayKeyFromUnknown(value: unknown): GiveawayKeyStatus | undefined {
  if (typeof value !== 'object' || !value) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const id = row.giveaway_id ?? row.giveawayId ?? row.id;
  if (typeof id !== 'string' && typeof id !== 'number') {
    return undefined;
  }
  const status = typeof row.status === 'string' ? row.status : '';
  const entry: GiveawayKeyStatus = {
    giveawayId: String(id),
    status,
  };
  const remaining = asFiniteNumber(row.remaining);
  if (remaining !== undefined) {
    entry.remaining = remaining;
  }
  return entry;
}

export function readPageGiveawayKeys(): GiveawayKeyStatus[] {
  let raw: unknown;
  try {
    raw = pageWindow().giveawayKeys;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const keys: GiveawayKeyStatus[] = [];
  for (const item of raw) {
    const entry = giveawayKeyFromUnknown(item);
    if (entry) {
      keys.push(entry);
    }
  }
  return keys;
}

export function giveawayKeyStatus(
  giveawayId: string,
): GiveawayKeyStatus | undefined {
  return readPageGiveawayKeys().find(
    (entry) => entry.giveawayId === giveawayId,
  );
}

export function readPageUsername(): string | undefined {
  try {
    const value = pageWindow().user_username;
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  } catch {
    // Tampermonkey throws if the page context is gone.
  }
  return undefined;
}
