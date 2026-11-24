import { firstNonEmpty } from '../../pageGlobals';
import { parseTimestamp } from './shared';
import type { SiteState } from './types';
import { canAffordVaultPrice, vaultPayArp } from './gameVault';

const FRAGMENT_CARD_SELECTORS = '.product-card.marketplace-product';
const CLAIMED_RE = /\bclaimed\b/i;
const OUT_OF_STOCK_RE = /out of stock/i;

export interface MarketplaceFragmentOffer {
  name: string;
  price: number;
  inStock: boolean;
  /**
  Blind auction — market % off does not apply (same rule as Game Vault).
  */
  isAuction?: boolean;
  /**
  Absolute listing end (`data-timer-end-date`), when present.
  */
  endsAt?: string;
  /**
  User already claimed this product (badge / copy). Many fragment offers remain
  re-claimable; treat as informational only.
  */
  isClaimed?: boolean;
  productId?: string;
}

function isListPriceFragment(offer: MarketplaceFragmentOffer): boolean {
  return offer.isAuction !== true;
}

export function isPostedListPriceFragment(
  offer: MarketplaceFragmentOffer,
): boolean {
  return offer.inStock && isListPriceFragment(offer);
}

/**
Timed fragment/artifact listings the user can still buy (has an end date).
*/
export function isExpiringFragmentOffer(
  offer: MarketplaceFragmentOffer,
  now = Date.now(),
): boolean {
  if (!isPostedListPriceFragment(offer) || !offer.endsAt) {
    return false;
  }
  const endsAt = Date.parse(offer.endsAt);
  return Number.isFinite(endsAt) && endsAt > now;
}

export function fragmentOfferEndsAtMs(
  offer: MarketplaceFragmentOffer,
): number | undefined {
  if (!offer.endsAt) {
    return undefined;
  }
  const endsAt = Date.parse(offer.endsAt);
  return Number.isFinite(endsAt) ? endsAt : undefined;
}

export function isAffordableFragmentOffer(
  offer: MarketplaceFragmentOffer,
  state: Pick<SiteState, 'arpLog'>,
  discountPct = 0,
  availableArp: number | undefined = state.arpLog?.redeemableArp,
): boolean {
  return (
    isPostedListPriceFragment(offer) &&
    canAffordVaultPrice(availableArp, vaultPayArp(offer.price, discountPct))
  );
}

export function expiringFragmentOffers(
  state: Pick<SiteState, 'marketplaceFragments'>,
  now = Date.now(),
): MarketplaceFragmentOffer[] {
  return (state.marketplaceFragments ?? []).filter((offer) =>
    isExpiringFragmentOffer(offer, now),
  );
}

/**
Soonest-ending affordable timed listing, prefer higher list price as the buy
target when several end at the same time.
Pass `shouldSkip` to drop listings the caller does not want (e.g. artifacts
already owned).
*/
export function primaryExpiringFragmentOffer(
  state: Pick<SiteState, 'marketplaceFragments' | 'arpLog'>,
  discountPct = 0,
  availableArp: number | undefined = state.arpLog?.redeemableArp,
  now = Date.now(),
  options: {
    shouldSkip?: (offer: MarketplaceFragmentOffer) => boolean;
  } = {},
): MarketplaceFragmentOffer | undefined {
  const shouldSkip = options.shouldSkip;
  const candidates = expiringFragmentOffers(state, now)
    .filter((offer) =>
      isAffordableFragmentOffer(offer, state, discountPct, availableArp),
    )
    .filter((offer) => !shouldSkip?.(offer))
    .toSorted((left, right) => {
      const leftEnd = fragmentOfferEndsAtMs(left) ?? Number.POSITIVE_INFINITY;
      const rightEnd = fragmentOfferEndsAtMs(right) ?? Number.POSITIVE_INFINITY;
      if (leftEnd !== rightEnd) {
        return leftEnd - rightEnd;
      }
      return right.price - left.price;
    });
  return candidates[0];
}

export function marketplaceFragmentsCatalogPrice(
  state: Pick<SiteState, 'marketplaceFragments' | 'arpLog'>,
  discountPct = 0,
  availableArp: number | undefined = state.arpLog?.redeemableArp,
  now = Date.now(),
): number {
  return (
    primaryExpiringFragmentOffer(state, discountPct, availableArp, now)
      ?.price ?? 0
  );
}

function fragmentCardName(item: HTMLElement): string {
  const named = item.querySelector(
    '.product-name, h3, h4, .marketplace-product-name',
  );
  return firstNonEmpty(
    item.dataset.productName?.trim(),
    named?.textContent.trim(),
    item.getAttribute('title'),
    'Marketplace item',
  );
}

function fragmentCardPrice(item: HTMLElement): number | undefined {
  const fromData = Number(item.dataset.productPrice);
  if (Number.isFinite(fromData) && fromData >= 0) {
    return fromData;
  }
  const match = /(\d{1,7})\s*ARP/i.exec(
    item.textContent.replaceAll(/\s+/g, ' '),
  );
  if (!match?.[1]) {
    return undefined;
  }
  const price = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

/**
AWA stores `data-timer-end-date` as `YYYY-MM-DD HH:mm:ss` without a zone.
Treat as UTC (same as other Arena clocks).
*/
export function parseMarketplaceTimerEndDate(
  raw: string | undefined,
): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withT = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(withT) ? withT : `${withT}Z`;
  const ms = parseTimestamp(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function fragmentTimerEndAt(item: HTMLElement): string | undefined {
  const timer = item.querySelector<HTMLElement>(
    '.marketplace-product-timer[data-timer-end-date], [data-timer-end-date]',
  );
  return parseMarketplaceTimerEndDate(timer?.dataset.timerEndDate);
}

function parseFragmentProductCard(
  item: HTMLElement,
): MarketplaceFragmentOffer | undefined {
  const price = fragmentCardPrice(item);
  if (price === undefined) {
    return undefined;
  }
  const text = item.textContent.replaceAll(/\s+/g, ' ');
  const isAuction =
    item.dataset.isBlindAuction === 'true' ||
    item.classList.contains('auction-game');
  const isInStock =
    item.dataset.productInStock !== 'false' && !OUT_OF_STOCK_RE.test(text);
  const isDisabled = item.dataset.productDisabled === 'true';
  const isClaimed = CLAIMED_RE.test(text);
  const endsAt = fragmentTimerEndAt(item);
  const nextItem: MarketplaceFragmentOffer = {
    name: fragmentCardName(item),
    price,
    inStock: isInStock && !isAuction && !isDisabled,
    isAuction,
  };
  if (endsAt) {
    nextItem.endsAt = endsAt;
  }
  if (isClaimed) {
    nextItem.isClaimed = true;
  }
  const productId = item.dataset.productId?.trim();
  if (productId) {
    nextItem.productId = productId;
  }
  return nextItem;
}

export function scrapeMarketplaceFragmentsFromDocument(
  document_: Document,
): MarketplaceFragmentOffer[] {
  const items = document_.querySelectorAll<HTMLElement>(FRAGMENT_CARD_SELECTORS);
  const result: MarketplaceFragmentOffer[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const nextItem = parseFragmentProductCard(item);
    if (!nextItem) {
      continue;
    }
    const id =
      item.dataset.productId ?? `${nextItem.price}:${nextItem.name}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(nextItem);
  }
  return result;
}

export function scrapeMarketplaceFragments(): MarketplaceFragmentOffer[] {
  return scrapeMarketplaceFragmentsFromDocument(document);
}

export function isMarketplaceFragmentsPath(
  path: string,
  search = '',
): boolean {
  if (!path.includes('/marketplace')) {
    return false;
  }
  if (path.includes('/game-vault')) {
    return false;
  }
  const parameters = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const type = parameters.get('type');
  // Default marketplace hub can also list fragments; `type=fragment` is the
  // dedicated Artifacts/Fragments tab. Also accept pages that already rendered
  // fragment product cards (checked by the apply helper).
  return type === 'fragment' || type === null || type === '';
}

export function applyMarketplaceFragmentsDocument(
  next: SiteState,
  document_: Document,
): void {
  const offers = scrapeMarketplaceFragmentsFromDocument(document_);
  if (offers.length === 0) {
    return;
  }
  next.marketplaceFragments = offers;
  next.marketplaceFragmentsScrapedAt = new Date().toISOString();
}
