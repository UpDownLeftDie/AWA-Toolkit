import { parseTimestamp } from './shared';
import { applyRedeemableArpFromDocument } from './arpLog';
import type { SiteState } from './types';

export interface GameVaultItem {
  name: string;
  price: number;
  inStock: boolean;
  /**
  False while the monthly vault countdown is active (`data-product-disabled`).
  Undefined on older cached scrapes — treat as unknown.
  */
  purchasable?: boolean;
  /**
  Blind auction — you name an ARP bid. Discord: market % off does not apply.
  */
  isAuction?: boolean;
  /**
  Minimum Arena tier to claim (`data-arp-tier`).
  */
  minTier?: number;
}

function isListPriceVaultClaim(game: GameVaultItem): boolean {
  return game.isAuction !== true;
}

function isVaultTierMet(
  game: GameVaultItem,
  userTier: number | undefined,
): boolean {
  if (userTier === undefined || game.minTier === undefined) {
    return true;
  }
  return userTier >= game.minTier;
}

export function vaultPayArp(price: number, discountPct = 0): number {
  const pct = Math.min(1, Math.max(0, discountPct));
  return Math.ceil(price * (1 - pct) - 1e-9);
}

export function vaultGamePayArp(game: GameVaultItem, discountPct = 0): number {
  return vaultPayArp(game.price, discountPct);
}

export function canAffordVaultPrice(
  redeemableArp: number | undefined,
  payArp: number,
): boolean {
  if (redeemableArp === undefined) {
    return true;
  }
  return redeemableArp >= payArp;
}

function isPostedListPriceVaultGame(game: GameVaultItem): boolean {
  return game.inStock && isListPriceVaultClaim(game);
}

/**
Posted list-price vault game this user could buy: in stock, tier, enough ARP.
Does not require the vault to be open yet (`purchasable` is false during countdown).
`availableArp` defaults to current redeemable; pass current + remaining-window
earnings to include quests still left today. Unknown ARP/tier does not exclude.
*/
export function isAffordableVaultOffer(
  game: GameVaultItem,
  state: Pick<SiteState, 'userArpTier' | 'arpLog'>,
  discountPct = 0,
  availableArp: number | undefined = state.arpLog?.redeemableArp,
): boolean {
  if (!isPostedListPriceVaultGame(game)) {
    return false;
  }
  if (!isVaultTierMet(game, state.userArpTier)) {
    return false;
  }
  return canAffordVaultPrice(availableArp, vaultGamePayArp(game, discountPct));
}

export function hasPostedListPriceVaultGames(state: SiteState): boolean {
  return state.gameVault.some((game) => isPostedListPriceVaultGame(game));
}

export function canAffordAnyVaultOffer(
  state: SiteState,
  discountPct = 0,
  availableArp: number | undefined = state.arpLog?.redeemableArp,
): boolean {
  return state.gameVault.some((game) =>
    isAffordableVaultOffer(game, state, discountPct, availableArp),
  );
}

/**
In-stock list-price vault game this user can claim right now: purchasable +
tier + enough redeemable ARP. `discountPct` is the market % off they would pay.
*/
export function isClaimableVaultGame(
  game: GameVaultItem,
  state: Pick<SiteState, 'userArpTier' | 'arpLog'>,
  discountPct = 0,
): boolean {
  return (
    game.purchasable === true &&
    isAffordableVaultOffer(game, state, discountPct)
  );
}

function isVaultStockForUser(
  game: GameVaultItem,
  userTier: number | undefined,
): boolean {
  return (
    game.purchasable === true &&
    isListPriceVaultClaim(game) &&
    isVaultTierMet(game, userTier)
  );
}

/**
True while this user still has an in-stock list-price Game Vault claim
(tier only — ARP is checked separately). Stock can run out at any time.
*/
export function isGameVaultStockOpen(state: SiteState): boolean {
  return state.gameVault.some((game) =>
    isVaultStockForUser(game, state.userArpTier),
  );
}

/**
True while this user still has an in-stock list-price Game Vault claim they
can afford right now (optionally after market discount).
*/
export function isGameVaultCurrentlyOpen(
  state: SiteState,
  discountPct = 0,
): boolean {
  return state.gameVault.some((game) =>
    isClaimableVaultGame(game, state, discountPct),
  );
}

/**
Logout/relogin slack so a lock lifting at open still counts as missing the start.
*/
export const GAME_VAULT_EQUIP_BUFFER_MS = 30 * 60 * 1000;

/**
Stable id for this vault rotation (countdown ISO, kept after open).
*/
export function gameVaultCycleId(state: SiteState): string | undefined {
  if (state.gameVaultOpensAt) {
    return state.gameVaultOpensAt;
  }
  if (isGameVaultStockOpen(state)) {
    return 'open';
  }
  return undefined;
}

export function gameVaultOpensAtMs(state: SiteState): number | undefined {
  const opensAt = parseTimestamp(state.gameVaultOpensAt);
  return Number.isFinite(opensAt) ? opensAt : undefined;
}

/**
True when slots stay locked past vault open, so discount gear cannot be equipped in time.
*/
export function willMissDiscountEquipBeforeOpen(
  lockUntilMs: number,
  state: SiteState,
  now = Date.now(),
): boolean {
  const opensAt = gameVaultOpensAtMs(state);
  if (opensAt === undefined || opensAt <= now) {
    return false;
  }
  return lockUntilMs + GAME_VAULT_EQUIP_BUFFER_MS > opensAt;
}

export function gameVaultCatalogPrice(
  state: SiteState,
  discountPct = 0,
): number {
  const buyable = state.gameVault.find((game) =>
    isClaimableVaultGame(game, state, discountPct),
  );
  return buyable?.price ?? 0;
}

export function scrapeGameVaultTimerMsFromDocument(
  document_: Document,
): number | undefined {
  const timer = document_.querySelector<HTMLElement>('#game-vault-timer');
  const raw =
    timer?.dataset.unlockDate ??
    timer?.dataset.endDate ??
    timer?.dataset.lockDate ??
    timer?.dataset.closeDate;
  const ms = parseTimestamp(raw?.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

export function scrapeGameVaultFromDocument(
  document_: Document,
): GameVaultItem[] {
  const items = document_.querySelectorAll<HTMLElement>(
    [
      '.gamevault-marketplace-product[data-product-price]',
      '.marketplace-game-product[data-product-price]',
    ].join(', '),
  );

  const result: GameVaultItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const priceRaw = item.dataset.productPrice;
    if (priceRaw === undefined) {
      continue;
    }
    const price = Number(priceRaw);
    if (Number.isNaN(price) || price <= 0) {
      continue;
    }
    const id =
      item.dataset.productId ?? `${price}:${item.dataset.productName ?? ''}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const isAuction =
      item.dataset.isBlindAuction === 'true' ||
      item.classList.contains('auction-game');
    const isInStock = item.dataset.productInStock !== 'false';
    const isDisabled = item.dataset.productDisabled === 'true';
    const minTierRaw = item.dataset.arpTier;
    const minTier = minTierRaw === undefined ? undefined : Number(minTierRaw);
    const name =
      item.dataset.productName?.trim() ||
      item
        .querySelector('.product-name, .gv-product-name, h3, h4')
        ?.textContent?.trim() ||
      item.getAttribute('title') ||
      'Game Vault item';
    const nextItem: GameVaultItem = {
      name,
      price,
      inStock: isInStock && !isAuction,
      purchasable: isInStock && !isDisabled && !isAuction,
      isAuction,
    };
    if (minTier !== undefined && Number.isFinite(minTier)) {
      nextItem.minTier = minTier;
    }
    result.push(nextItem);
  }
  return result;
}

export function scrapeGameVault(): GameVaultItem[] {
  return scrapeGameVaultFromDocument(document);
}

export function scrapeUserArpTierFromDocument(
  document_: Document,
): number | undefined {
  if (document_ === document) {
    const arpTier = (globalThis as typeof globalThis & { arp_tier?: unknown })
      .arp_tier;
    if (
      typeof arpTier === 'number' &&
      Number.isFinite(arpTier) &&
      arpTier >= 0
    ) {
      return arpTier;
    }
  }
  for (const script of document_.querySelectorAll('script')) {
    const match = /(?:var\s+|window\.)?arp_tier\s*=\s*(\d+)/.exec(
      script.textContent ?? '',
    );
    if (match?.[1]) {
      return Number(match[1]);
    }
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

function applyGameVaultSchedule(
  next: SiteState,
  timerMs: number | undefined,
  isOpen: boolean,
  now: number,
): void {
  if (isOpen) {
    const existingOpen = parseTimestamp(next.gameVaultOpensAt);
    if (!Number.isFinite(existingOpen) || existingOpen > now) {
      next.gameVaultOpensAt = new Date(now).toISOString();
    }
    return;
  }
  if (timerMs !== undefined && timerMs > now) {
    next.gameVaultOpensAt = new Date(timerMs).toISOString();
    return;
  }
  delete next.gameVaultOpensAt;
}

export function applyGameVaultDocument(
  next: SiteState,
  document_: Document,
): void {
  const tier = scrapeUserArpTierFromDocument(document_);
  if (tier !== undefined) {
    next.userArpTier = tier;
  }
  applyRedeemableArpFromDocument(next, document_);
  const vault = scrapeGameVaultFromDocument(document_);
  const timerMs = scrapeGameVaultTimerMsFromDocument(document_);
  if (timerMs === undefined && vault.length === 0) {
    return;
  }
  if (vault.length > 0) {
    next.gameVault = vault;
  }
  applyGameVaultSchedule(
    next,
    timerMs,
    vault.some((game) => isVaultStockForUser(game, next.userArpTier)),
    Date.now(),
  );
}
