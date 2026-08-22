import { readPageArpTier } from "../../pageGlobals";
import { pageText, parseTimestamp } from "./shared";
import { applyRedeemableArpFromDocument } from "./arpLog";
import type { SiteState } from "./types";

const MONTHLY_VAULT_CLAIM_USED_RE = /already claimed a game this month/i;
const VAULT_CLAIMED_BADGE_RE = /\bclaimed\b/i;
const VAULT_CLAIM_ACTION_RE = /\bclaim\b/i;
const VAULT_CARD_SELECTORS = [
  ".gamevault-marketplace-product[data-product-price]",
  ".marketplace-game-product[data-product-price]",
  ".pointer.marketplace-game-small",
  ".pointer.marketplace-game-large",
].join(", ");

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
  /**
  This user already claimed this title (`Claimed` badge).
  */
  isClaimed?: boolean;
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
  state: Pick<SiteState, "userArpTier" | "arpLog">,
  discountPct = 0,
  availableArp: number | undefined = state.arpLog?.redeemableArp,
): boolean {
  if (game.isClaimed === true) {
    return false;
  }
  if (!isPostedListPriceVaultGame(game)) {
    return false;
  }
  if (!isVaultTierMet(game, state.userArpTier)) {
    return false;
  }
  return canAffordVaultPrice(availableArp, vaultGamePayArp(game, discountPct));
}

/**
True after this user spent their one list-price Game Vault claim this rotation.
*/
export function hasUsedMonthlyVaultClaim(
  state: Pick<SiteState, "gameVault" | "gameVaultClaimedThisCycle">,
): boolean {
  return (
    state.gameVaultClaimedThisCycle === true ||
    state.gameVault.some((game) => game.isClaimed === true)
  );
}

/**
SSR fetch HTML still looks purchasable after a claim (the overlay is
JS-rendered). Only a live/iframe document can clear the flag.
*/
export function isGameVaultClaimedThisCycle(
  previous: boolean | undefined,
  options: {
    isMonthlyClaimUsed: boolean;
    isScrapedClaimed: boolean;
    isLiveDocument: boolean;
    hasClaimAction: boolean;
  },
): boolean {
  if (options.isMonthlyClaimUsed || options.isScrapedClaimed) {
    return true;
  }
  if (options.isLiveDocument && options.hasClaimAction) {
    return false;
  }
  return previous === true;
}

export function isLiveVaultDocument(document_: Document): boolean {
  return Boolean(document_.defaultView);
}

export function hasPostedListPriceVaultGames(state: SiteState): boolean {
  return state.gameVault.some((game) => isPostedListPriceVaultGame(game));
}

export function canAffordAnyVaultOffer(
  state: SiteState,
  discountPct = 0,
  availableArp: number | undefined = state.arpLog?.redeemableArp,
): boolean {
  if (hasUsedMonthlyVaultClaim(state)) {
    return false;
  }
  return state.gameVault.some((game) =>
    isAffordableVaultOffer(game, state, discountPct, availableArp),
  );
}

/**
True when this list-price game can be claimed now. `purchasable: false` is the
countdown scrape (`data-product-disabled`); once `gameVaultOpensAt` has passed,
treat it as live so a stale flag cannot drop the discount window.
*/
export function isVaultItemPurchasable(
  game: GameVaultItem,
  state: Pick<SiteState, "gameVaultOpensAt">,
  now = Date.now(),
): boolean {
  if (game.isClaimed === true) {
    return false;
  }
  if (!isListPriceVaultClaim(game) || !game.inStock) {
    return false;
  }
  if (game.purchasable === true) {
    return true;
  }
  const opensAt = gameVaultOpensAtMs(state);
  return opensAt !== undefined && opensAt <= now;
}

/**
In-stock list-price vault game this user can claim right now: purchasable +
tier + enough redeemable ARP. `discountPct` is the market % off they would pay.
*/
export function isClaimableVaultGame(
  game: GameVaultItem,
  state: Pick<SiteState, "userArpTier" | "arpLog" | "gameVaultOpensAt">,
  discountPct = 0,
  now = Date.now(),
): boolean {
  return (
    isVaultItemPurchasable(game, state, now) &&
    isAffordableVaultOffer(game, state, discountPct)
  );
}

function isVaultStockForUser(
  game: GameVaultItem,
  state: SiteState,
  now = Date.now(),
): boolean {
  return (
    isVaultItemPurchasable(game, state, now) &&
    isVaultTierMet(game, state.userArpTier)
  );
}

/**
True while this user still has an in-stock list-price Game Vault claim
(tier only — ARP is checked separately). Stock can run out at any time.
*/
export function isGameVaultStockOpen(
  state: SiteState,
  now = Date.now(),
): boolean {
  if (hasUsedMonthlyVaultClaim(state)) {
    return false;
  }
  return state.gameVault.some((game) => isVaultStockForUser(game, state, now));
}

/**
Hold / equip market-discount while any in-stock list-price vault game is still
available to this user. True after open (including stale `purchasable: false`
once the countdown has elapsed) and when the timer node is gone but catalog
remains. False after this user has claimed this rotation, and while a future
countdown is running.
*/
export function isGameVaultDiscountWindow(
  state: SiteState,
  now = Date.now(),
): boolean {
  if (hasUsedMonthlyVaultClaim(state)) {
    return false;
  }
  if (isGameVaultStockOpen(state, now)) {
    return true;
  }
  const opensAt = gameVaultOpensAtMs(state);
  if (opensAt !== undefined && opensAt > now) {
    return false;
  }
  return state.gameVault.some(
    (game) =>
      isPostedListPriceVaultGame(game) &&
      isVaultTierMet(game, state.userArpTier),
  );
}

/**
True while this user still has an in-stock list-price Game Vault claim they
can afford right now (optionally after market discount).
*/
export function isGameVaultCurrentlyOpen(
  state: SiteState,
  discountPct = 0,
  now = Date.now(),
): boolean {
  if (hasUsedMonthlyVaultClaim(state)) {
    return false;
  }
  return state.gameVault.some((game) =>
    isClaimableVaultGame(game, state, discountPct, now),
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
    return "open";
  }
  return undefined;
}

export function gameVaultOpensAtMs(
  state: Pick<SiteState, "gameVaultOpensAt">,
): number | undefined {
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
  now = Date.now(),
): number {
  const buyable = state.gameVault.find((game) =>
    isClaimableVaultGame(game, state, discountPct, now),
  );
  return buyable?.price ?? 0;
}

export function scrapeGameVaultTimerMsFromDocument(
  document_: Document,
): number | undefined {
  const timer = document_.querySelector<HTMLElement>("#game-vault-timer");
  const raw =
    timer?.dataset.unlockDate ??
    timer?.dataset.endDate ??
    timer?.dataset.lockDate ??
    timer?.dataset.closeDate;
  const ms = parseTimestamp(raw?.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

export function isGameVaultMonthlyClaimUsedFromDocument(
  document_: Document,
): boolean {
  return MONTHLY_VAULT_CLAIM_USED_RE.test(pageText(document_));
}

function isVaultCardClaimedByUser(item: HTMLElement): boolean {
  return VAULT_CLAIMED_BADGE_RE.test(
    (item.textContent ?? "").replaceAll(/\s+/g, " "),
  );
}

function vaultCardName(item: HTMLElement): string {
  return (
    item.dataset.productName?.trim() ||
    item
      .querySelector(".product-name, .gv-product-name, h3, h4")
      ?.textContent?.trim() ||
    item.getAttribute("title") ||
    "Game Vault item"
  );
}

function vaultCardPrice(item: HTMLElement): number | undefined {
  const fromData = Number(item.dataset.productPrice);
  if (Number.isFinite(fromData) && fromData > 0) {
    return fromData;
  }
  const match = /(\d{1,7})\s*ARP/i.exec(
    (item.textContent ?? "").replaceAll(/\s+/g, " "),
  );
  if (!match?.[1]) {
    return undefined;
  }
  const price = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

function parseVaultProductCard(item: HTMLElement): GameVaultItem | undefined {
  const price = vaultCardPrice(item);
  if (price === undefined) {
    return undefined;
  }
  const isAuction =
    item.dataset.isBlindAuction === "true" ||
    item.classList.contains("auction-game");
  const isInStock = item.dataset.productInStock !== "false";
  const isDisabled = item.dataset.productDisabled === "true";
  const minTierRaw = item.dataset.arpTier;
  const minTier = minTierRaw === undefined ? undefined : Number(minTierRaw);
  const isClaimed = isVaultCardClaimedByUser(item);
  const nextItem: GameVaultItem = {
    name: vaultCardName(item),
    price,
    inStock: isInStock && !isAuction,
    purchasable: isInStock && !isDisabled && !isAuction && !isClaimed,
    isAuction,
  };
  if (minTier !== undefined && Number.isFinite(minTier)) {
    nextItem.minTier = minTier;
  }
  if (isClaimed) {
    nextItem.isClaimed = true;
  }
  return nextItem;
}

export function scrapeGameVaultFromDocument(
  document_: Document,
): GameVaultItem[] {
  const items = document_.querySelectorAll<HTMLElement>(VAULT_CARD_SELECTORS);

  const result: GameVaultItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const nextItem = parseVaultProductCard(item);
    if (!nextItem) {
      continue;
    }
    const id = item.dataset.productId ?? `${nextItem.price}:${nextItem.name}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(nextItem);
  }
  return result;
}

export function scrapeGameVault(): GameVaultItem[] {
  return scrapeGameVaultFromDocument(document);
}

export function hasVaultClaimActionFromDocument(document_: Document): boolean {
  const cards = document_.querySelectorAll<HTMLElement>(VAULT_CARD_SELECTORS);
  if (cards.length > 0) {
    return [...cards].some((item) => {
      const text = (item.textContent ?? "").replaceAll(/\s+/g, " ");
      return (
        VAULT_CLAIM_ACTION_RE.test(text) && !VAULT_CLAIMED_BADGE_RE.test(text)
      );
    });
  }
  const text = pageText(document_).replaceAll(/\s+/g, " ");
  return (
    VAULT_CLAIM_ACTION_RE.test(text) && !VAULT_CLAIMED_BADGE_RE.test(text)
  );
}

export function isGameVaultDocumentReady(document_: Document): boolean {
  if (isGameVaultMonthlyClaimUsedFromDocument(document_)) {
    return true;
  }
  if (hasVaultClaimActionFromDocument(document_)) {
    return true;
  }
  return scrapeGameVaultFromDocument(document_).some(
    (game) => game.isClaimed === true,
  );
}

export function scrapeUserArpTierFromDocument(
  document_: Document,
): number | undefined {
  return readPageArpTier(document_);
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
  // Timer gone (or elapsed) while list-price catalog is still posted: the
  // rotation has opened. Keep a past opensAt so discount logic does not
  // fall through to a 24h ARP swap.
  if (next.gameVault.some((game) => isPostedListPriceVaultGame(game))) {
    const existingOpen = parseTimestamp(next.gameVaultOpensAt);
    if (!Number.isFinite(existingOpen) || existingOpen > now) {
      next.gameVaultOpensAt = new Date(now).toISOString();
    }
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
  const isMonthlyClaimUsed = isGameVaultMonthlyClaimUsedFromDocument(document_);
  const shouldApplyVault =
    isMonthlyClaimUsed || vault.length > 0 || timerMs !== undefined;
  if (!shouldApplyVault) {
    return;
  }
  if (vault.length > 0) {
    next.gameVault = vault;
  }
  next.gameVaultClaimedThisCycle = isGameVaultClaimedThisCycle(
    next.gameVaultClaimedThisCycle,
    {
      isMonthlyClaimUsed,
      isScrapedClaimed: vault.some((game) => game.isClaimed === true),
      isLiveDocument: isLiveVaultDocument(document_),
      hasClaimAction: hasVaultClaimActionFromDocument(document_),
    },
  );
  applyGameVaultSchedule(
    next,
    timerMs,
    vault.some((game) => isVaultStockForUser(game, next)),
    Date.now(),
  );
}
