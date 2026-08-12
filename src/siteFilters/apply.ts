import {
  DEFAULT_USER_TIER,
  extractTier,
  getSettings,
  type FilterMode,
  type FilterSettings,
} from './settings';

type FilterEffect = 'none' | 'dim' | 'hide';

const FILTER_STYLE_ID = 'alienware-filter-styles';
const FILTER_DIM_CLASS = 'awa-filter-dimmed';
const FILTER_STATE_ATTR = 'data-awa-filter';

function parseTimestamp(value: string): number | undefined {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
}

function isGiveawayClosed(giveaway: HTMLElement): boolean {
  const timeElement = giveaway.querySelector<HTMLElement>(
    '.community-giveaways__listing-row__time',
  );
  const timeText = (timeElement?.textContent ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  // Infinite-scroll tiles render "Closed" when the API omits closesAt.
  if (/\bclosed\b/i.test(timeText)) {
    return true;
  }

  const closeStamp = timeElement
    ?.querySelector('.timeago-future')
    ?.getAttribute('title');
  if (!closeStamp) {
    return false;
  }
  const closeMs = parseTimestamp(closeStamp);
  return closeMs !== undefined && closeMs <= Date.now();
}

function isGiveawayEntered(giveaway: HTMLElement): boolean {
  return /you have entered this giveaway/i.test(giveaway.textContent ?? '');
}

function combineFilterMode(
  current: FilterEffect,
  mode: FilterMode,
  isMatching: boolean,
): FilterEffect {
  if (!isMatching || mode === 'off') {
    return current;
  }
  if (mode === 'hide' || current === 'hide') {
    return 'hide';
  }
  return 'dim';
}

function marketplaceFilterTarget(item: HTMLElement): HTMLElement {
  return (
    item.closest<HTMLElement>('[class*="marketplace-product-block-"]') ?? item
  );
}

function applyFilterEffect(target: HTMLElement, effect: FilterEffect): void {
  const previous = target.getAttribute(FILTER_STATE_ATTR);
  if (effect === 'none') {
    if (previous === 'hide') {
      target.style.removeProperty('display');
    }
    target.classList.remove(FILTER_DIM_CLASS);
    target.removeAttribute(FILTER_STATE_ATTR);
    return;
  }

  target.setAttribute(FILTER_STATE_ATTR, effect);
  target.classList.toggle(FILTER_DIM_CLASS, effect === 'dim');
  if (effect === 'hide') {
    target.style.display = 'none';
    return;
  }
  if (previous === 'hide') {
    target.style.removeProperty('display');
  }
}

function marketplaceFilterEffect(
  item: HTMLElement,
  settings: FilterSettings,
  userTier: number,
): FilterEffect {
  const text = item.textContent || '';
  const normalizedText = text.toLowerCase();
  let effect: FilterEffect = 'none';

  effect = combineFilterMode(
    effect,
    settings.outOfStock,
    normalizedText.includes('out of stock') ||
      item.dataset.productInStock === 'false',
  );
  effect = combineFilterMode(
    effect,
    settings.claimed,
    normalizedText.includes('claimed'),
  );
  const tierNumber = extractTier(text);
  effect = combineFilterMode(
    effect,
    settings.higherTier,
    tierNumber !== undefined && tierNumber > userTier,
  );
  return effect;
}

function giveawayFilterEffect(
  giveaway: HTMLElement,
  settings: FilterSettings,
  userTier: number,
): FilterEffect {
  let effect: FilterEffect = 'none';
  effect = combineFilterMode(
    effect,
    settings.closedGiveaways,
    isGiveawayClosed(giveaway),
  );
  effect = combineFilterMode(
    effect,
    settings.enteredGiveaways,
    isGiveawayEntered(giveaway),
  );
  const tierText =
    giveaway.querySelector('.community-giveaways__listing-row__tier')
      ?.textContent ?? '';
  const tierNumber = extractTier(tierText);
  effect = combineFilterMode(
    effect,
    settings.higherTier,
    tierNumber !== undefined && tierNumber > userTier,
  );
  return effect;
}

export async function filterGiveaways(): Promise<void> {
  const settings = await getSettings();
  const userTier = settings.userTier ?? DEFAULT_USER_TIER;
  const giveaways = document.querySelectorAll<HTMLElement>(
    '.community-giveaways__listing__row',
  );

  giveaways.forEach((giveaway) => {
    applyFilterEffect(
      giveaway,
      giveawayFilterEffect(giveaway, settings, userTier),
    );
  });
}

export async function filterMarketplace(): Promise<void> {
  const settings = await getSettings();
  const userTier = settings.userTier ?? DEFAULT_USER_TIER;
  const items = document.querySelectorAll<HTMLElement>(
    [
      // Current marketplace rewards grid
      '.product-card.marketplace-product',
      // Game Vault cards
      '.pointer.marketplace-game-small',
      '.pointer.marketplace-game-large',
    ].join(', '),
  );

  items.forEach((item) => {
    applyFilterEffect(
      marketplaceFilterTarget(item),
      marketplaceFilterEffect(item, settings, userTier),
    );
  });
}

export function ensureFilterStyles(): void {
  if (document.querySelector(`#${FILTER_STYLE_ID}`)) {
    return;
  }
  const style = document.createElement('style');
  style.id = FILTER_STYLE_ID;
  style.textContent = `
        .${FILTER_DIM_CLASS} {
          opacity: 0.4 !important;
          filter: grayscale(0.55);
        }
      `;
  (document.head ?? document.documentElement).append(style);
}

export function watchPageFilters(): void {
  const currentPath = location.pathname;
  if (currentPath === '/community-giveaways') {
    const observer = new MutationObserver(() => {
      void filterGiveaways();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    void filterGiveaways();
    return;
  }
  if (currentPath.startsWith('/marketplace')) {
    const observer = new MutationObserver(() => {
      void filterMarketplace();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    void filterMarketplace();
  }
}
