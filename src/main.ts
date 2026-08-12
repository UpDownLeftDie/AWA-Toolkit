import { GM } from '$';

import { initArtifactOptimizer } from './artifacts/ui';
import { initUcfReadingMode } from './ucf/readingMode';

type FilterMode = 'off' | 'dim' | 'hide';
type FilterEffect = 'none' | 'dim' | 'hide';

interface FilterSettings {
  higherTier: FilterMode;
  autoSyncTier: boolean;
  outOfStock: FilterMode;
  claimed: FilterMode;
  closedGiveaways: FilterMode;
  enteredGiveaways: FilterMode;
  userTier?: number;
}

const DEFAULT_USER_TIER = 99;
const FILTER_STYLE_ID = 'alienware-filter-styles';
const FILTER_DIM_CLASS = 'awa-filter-dimmed';
const FILTER_STATE_ATTR = 'data-awa-filter';

const defaultSettings: FilterSettings = {
  higherTier: 'hide',
  autoSyncTier: true,
  outOfStock: 'hide',
  claimed: 'hide',
  closedGiveaways: 'hide',
  enteredGiveaways: 'hide',
};

const FILTER_MODES = new Set<string>(['off', 'dim', 'hide']);

function isFilterMode(value: unknown): value is FilterMode {
  return typeof value === 'string' && FILTER_MODES.has(value);
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function filterModeFromSaved(
  parsed: Record<string, unknown>,
  modeKey: string,
  legacyHideKey: string,
  fallback: FilterMode,
): FilterMode {
  if (isFilterMode(parsed[modeKey])) {
    return parsed[modeKey];
  }
  const legacyHide = parsed[legacyHideKey];
  if (typeof legacyHide === 'boolean') {
    return legacyHide ? 'hide' : 'off';
  }
  return fallback;
}

async function getSettings(): Promise<FilterSettings> {
  const savedSettings: string | Partial<FilterSettings> | undefined =
    await GM.getValue('filterSettings');
  const settings: FilterSettings = { ...defaultSettings };

  if (!savedSettings) {
    return settings;
  }

  try {
    const parsedUnknown: unknown =
      typeof savedSettings === 'string'
        ? JSON.parse(savedSettings)
        : savedSettings;
    if (!isSettingsRecord(parsedUnknown)) {
      return settings;
    }
    const parsed = parsedUnknown;
    settings.higherTier = filterModeFromSaved(
      parsed,
      'higherTier',
      'hideTierRestricted',
      defaultSettings.higherTier,
    );
    settings.outOfStock = filterModeFromSaved(
      parsed,
      'outOfStock',
      'hideOutOfStock',
      defaultSettings.outOfStock,
    );
    settings.claimed = filterModeFromSaved(
      parsed,
      'claimed',
      'hideClaimed',
      defaultSettings.claimed,
    );
    settings.closedGiveaways = filterModeFromSaved(
      parsed,
      'closedGiveaways',
      'hideClosedGiveaways',
      defaultSettings.closedGiveaways,
    );
    settings.enteredGiveaways = isFilterMode(parsed.enteredGiveaways)
      ? parsed.enteredGiveaways
      : defaultSettings.enteredGiveaways;
    if (typeof parsed.autoSyncTier === 'boolean') {
      settings.autoSyncTier = parsed.autoSyncTier;
    }
    if (parsed.userTier !== undefined) {
      const tierValue = Number(parsed.userTier);
      if (!Number.isNaN(tierValue)) {
        settings.userTier = tierValue;
      }
    }
  } catch (error) {
    console.error('Error parsing saved settings:', error);
    return defaultSettings;
  }

  return settings;
}

async function saveSettings(settings: Partial<FilterSettings>): Promise<void> {
  const previousSettings = await getSettings();
  const newSettings = {
    ...previousSettings,
    ...settings,
  };
  await GM.setValue('filterSettings', JSON.stringify(newSettings));
}

// Function to extract tier number from text
function extractTier(text: string): number | undefined {
  const match = /Tier\s*(\d+)/i.exec(text);
  if (match?.[1]) {
    return Number(match[1]);
  }
  return undefined;
}

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

function readPageUserTier(): number | undefined {
  const arpTier = (globalThis as typeof globalThis & { arp_tier?: unknown })
    .arp_tier;
  if (typeof arpTier === 'number' && !Number.isNaN(arpTier)) {
    return arpTier;
  }

  const tierImg = document.querySelector<HTMLImageElement>(
    'img[src*="/images/content/tier-tags/"]',
  );
  if (!tierImg) {
    return undefined;
  }

  const tierMatch = /tier-tags\/(\d+)\.png/.exec(tierImg.src);
  if (!tierMatch?.[1]) {
    return undefined;
  }

  const userTier = Number(tierMatch[1]);
  return Number.isNaN(userTier) ? undefined : userTier;
}

// Function to check and store user's tier (control center badge or page global)
async function checkAndStoreTier(): Promise<void> {
  const userTier = readPageUserTier();
  if (userTier === undefined) {
    return;
  }

  await saveSettings({ userTier });
  console.log('Stored user tier:', userTier);
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

async function filterGiveaways(): Promise<void> {
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

async function filterMarketplace(): Promise<void> {
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

function ensureFilterStyles(): void {
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

function waitForBody(): Promise<HTMLElement> {
  if (document.body) {
    return Promise.resolve(document.body);
  }
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body) {
        return;
      }
      observer.disconnect();
      resolve(document.body);
    });
    observer.observe(document.documentElement, { childList: true });
  });
}

function buildSettingsMenuStyles(): string {
  return `
      <style>
        #alienware-filter-settings-backdrop {
          display: none;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.72);
          z-index: 10000;
        }
        #alienware-filter-settings {
          display: none;
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: #1a1a1a !important;
          background-color: #1a1a1a !important;
          opacity: 1 !important;
          color: #fff;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #333;
          z-index: 10001;
          min-width: 320px;
          max-width: min(460px, 94vw);
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.85);
          isolation: isolate;
        }
        #settings-title {
          color: #fff;
          font-size: 1.5em;
          font-weight: bold;
          margin-bottom: 15px;
        }
        #manualSetTier {
          color: white;
          padding: 2px;
          text-align: center;
        }
        #manualSetTier:disabled {
          color: grey;
        }
        .section-heading {
          color: #00bc8c;
          font-size: 1.1em;
          margin-bottom: 10px;
          font-weight: bold;
        }
        .setting {
          margin-bottom: 10px;
          margin-left: 15px;
        }
        .setting-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .setting-row .settingsLabel {
          display: inline;
          margin-bottom: 0;
          flex: 1;
        }
        .awa-filter-mode {
          background: #111;
          color: #fff;
          border: 1px solid #555;
          border-radius: 4px;
          padding: 3px 6px;
          min-width: 5.2em;
        }
        .settingsLabel {
          color: #fff;
          display: block;
          margin-bottom: 5px;
        }
        #saveFilterSettings {
          background: #00bc8c;
          color: #fff;
          border: none;
          padding: 5px 15px;
          border-radius: 4px;
          cursor: pointer;
        }
        #closeFilterSettings {
          background: #e74c3c;
          color: #fff;
          border: none;
          padding: 5px 15px;
          border-radius: 4px;
          margin-left: 10px;
          cursor: pointer;
        }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          border: 0;
        }
      </style>
    `;
}

function buildFilterModeOptions(mode: FilterMode): string {
  return (
    [
      ['off', 'Show'],
      ['dim', 'Dim'],
      ['hide', 'Hide'],
    ] as const
  )
    .map(
      ([value, label]) =>
        `<option value="${value}" ${mode === value ? 'selected' : ''}>${label}</option>`,
    )
    .join('');
}

function buildFilterModeRow(
  id: string,
  label: string,
  description: string,
  mode: FilterMode,
): string {
  return `
                <div class="setting setting-row">
                  <label class="settingsLabel" for="${id}">${label}</label>
                  <select id="${id}" class="awa-filter-mode" aria-describedby="${id}Desc">
                    ${buildFilterModeOptions(mode)}
                  </select>
                  <span id="${id}Desc" class="sr-only">${description}</span>
                </div>`;
}

function buildGlobalSettingsSection(settings: FilterSettings): string {
  const isHigherTierOff = settings.higherTier === 'off';
  return `
            <div class="settings-section" style="margin-bottom: 20px">
              <div role="heading" aria-level="2" class="section-heading">
                Global Settings
              </div>
              <div
                class="settings-group"
                role="group"
                aria-label="Global Filter Options">
                ${buildFilterModeRow(
                  'higherTier',
                  'Higher Tier Content',
                  'Show, dim, or hide content that requires a higher tier than yours',
                  settings.higherTier,
                )}
                <div class="setting">
                  <label class="settingsLabel">
                    <input type="checkbox" id="autoSyncTier" ${
                      isHigherTierOff ? 'disabled' : ''
                    } ${settings.autoSyncTier ? 'checked' : ''}
                    aria-describedby="autoSyncTierDesc"> Auto Sync Tier
                  </label>
                  <span id="autoSyncTierDesc" class="sr-only"
                    >If checked, tier restrictions will be automatically synced from
                    your profile</span
                  >
                </div>
                <div class="setting">
                  <label class="settingsLabel">
                    User tier:
                    <input id="manualSetTier" type="text" inputmode="numeric" pattern="[0-9]*" size="1" maxlength="2" ${
                      isHigherTierOff || settings.autoSyncTier ? 'disabled' : ''
                    } value="${settings.userTier || ''}"
                    aria-describedby="manualSetTierDesc">
                  </label>
                  <span id="manualSetTierDesc" class="sr-only">
                    The user tier that is used to filter content on the site</span>
                </div>
              </div>
            </div>`;
}

function buildMarketplaceSettingsSection(settings: FilterSettings): string {
  return `
            <div class="settings-section" style="margin-bottom: 20px">
              <div role="heading" aria-level="2" class="section-heading">
                Marketplace &amp; Game Vault
              </div>
              <div
                class="settings-group"
                role="group"
                aria-label="Marketplace Options">
                ${buildFilterModeRow(
                  'outOfStock',
                  'Out of Stock Items',
                  'Show, dim, or hide marketplace items that are out of stock',
                  settings.outOfStock,
                )}
                ${buildFilterModeRow(
                  'claimed',
                  'Claimed Items',
                  'Show, dim, or hide marketplace items you have already claimed',
                  settings.claimed,
                )}
              </div>
            </div>`;
}

function buildGiveawaysSettingsSection(settings: FilterSettings): string {
  return `
            <div class="settings-section" style="margin-bottom: 20px">
              <div role="heading" aria-level="2" class="section-heading">
                Community Giveaways
              </div>
              <div
                class="settings-group"
                role="group"
                aria-label="Community Giveaway Options">
                ${buildFilterModeRow(
                  'closedGiveaways',
                  'Closed Giveaways',
                  'Show, dim, or hide giveaways that have ended',
                  settings.closedGiveaways,
                )}
                ${buildFilterModeRow(
                  'enteredGiveaways',
                  'Entered Giveaways',
                  'Show, dim, or hide giveaways you have already entered',
                  settings.enteredGiveaways,
                )}
              </div>
            </div>`;
}

function buildSettingsMenuHTML(settings: FilterSettings): string {
  return `
      <div id="alienware-filter-settings-backdrop" style="display: none" hidden></div>
      <div
        id="alienware-filter-settings"
        role="dialog"
        aria-labelledby="settings-title"
        aria-modal="true"
        hidden
        style="display: none">
        <div role="document">
          <div id="settings-title" role="heading" aria-level="1">Filter Settings</div>
          <form>
            ${buildGlobalSettingsSection(settings)}
            ${buildMarketplaceSettingsSection(settings)}
            ${buildGiveawaysSettingsSection(settings)}
            <div style="text-align: right">
              <button id="saveFilterSettings" type="submit">Save</button>
              <button id="closeFilterSettings" type="button">Close</button>
            </div>
          </form>
        </div>
      </div>
      ${buildSettingsMenuStyles()}
    `;
}

function isCheckboxChecked(id: string): boolean {
  return document.querySelector<HTMLInputElement>(`#${id}`)?.checked ?? false;
}

function getFilterSettingsModal(): HTMLElement | undefined {
  return (
    document.querySelector<HTMLElement>('#alienware-filter-settings') ??
    undefined
  );
}

function getFilterSettingsBackdrop(): HTMLElement | undefined {
  return (
    document.querySelector<HTMLElement>(
      '#alienware-filter-settings-backdrop',
    ) ?? undefined
  );
}

function setFilterSettingsOpen(isOpen: boolean): void {
  const modal = getFilterSettingsModal();
  if (!modal) {
    return;
  }
  const backdrop = getFilterSettingsBackdrop();
  modal.style.display = isOpen ? 'block' : 'none';
  modal.hidden = !isOpen;
  if (backdrop) {
    backdrop.style.display = isOpen ? 'block' : 'none';
    backdrop.hidden = !isOpen;
  }
}

function readFilterModeFromForm(id: string, fallback: FilterMode): FilterMode {
  const value = document.querySelector<HTMLSelectElement>(`#${id}`)?.value;
  return isFilterMode(value) ? value : fallback;
}

function readSettingsFromForm(): FilterSettings {
  const isAutoSyncTier = isCheckboxChecked('autoSyncTier');
  const higherTier = readFilterModeFromForm(
    'higherTier',
    defaultSettings.higherTier,
  );

  return {
    higherTier,
    autoSyncTier: isAutoSyncTier,
    outOfStock: readFilterModeFromForm(
      'outOfStock',
      defaultSettings.outOfStock,
    ),
    claimed: readFilterModeFromForm('claimed', defaultSettings.claimed),
    closedGiveaways: readFilterModeFromForm(
      'closedGiveaways',
      defaultSettings.closedGiveaways,
    ),
    enteredGiveaways: readFilterModeFromForm(
      'enteredGiveaways',
      defaultSettings.enteredGiveaways,
    ),
    ...(!isAutoSyncTier &&
      higherTier !== 'off' && {
        userTier: Number(
          document.querySelector<HTMLInputElement>('#manualSetTier')?.value,
        ),
      }),
  };
}

function bindSettingsMenuFocusTrap(modal: HTMLElement): void {
  modal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') {
      return;
    }

    const focusableElements: HTMLElement[] = [
      ...modal.querySelectorAll<HTMLElement>('button, input, select'),
    ];
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements.at(-1);
    if (firstFocusable === undefined || lastFocusable === undefined) {
      return;
    }

    if (event.shiftKey) {
      if (document.activeElement === firstFocusable) {
        lastFocusable.focus();
        event.preventDefault();
      }
    } else if (document.activeElement === lastFocusable) {
      firstFocusable.focus();
      event.preventDefault();
    }
  });
}

function syncTierInputState(): void {
  const higherTier = readFilterModeFromForm(
    'higherTier',
    defaultSettings.higherTier,
  );
  const autoSync = document.querySelector<HTMLInputElement>('#autoSyncTier');
  const manualTier = document.querySelector<HTMLInputElement>('#manualSetTier');
  const isHigherTierOff = higherTier === 'off';
  if (autoSync) {
    autoSync.disabled = isHigherTierOff;
  }
  if (manualTier) {
    manualTier.disabled = isHigherTierOff || (autoSync?.checked ?? true);
  }
}

function bindSettingsMenuEvents(modal: HTMLElement): void {
  document.querySelector('#higherTier')?.addEventListener('change', () => {
    syncTierInputState();
  });
  document.querySelector('#autoSyncTier')?.addEventListener('change', () => {
    syncTierInputState();
  });

  document
    .querySelector('#saveFilterSettings')
    ?.addEventListener('click', (event) => {
      event.preventDefault();
      void saveSettings(readSettingsFromForm());
      setFilterSettingsOpen(false);
      location.reload(); // Reload to apply new settings
    });

  document
    .querySelector('#closeFilterSettings')
    ?.addEventListener('click', () => {
      setFilterSettingsOpen(false);
    });

  getFilterSettingsBackdrop()?.addEventListener('click', () => {
    setFilterSettingsOpen(false);
  });

  // Handle ESC key to close modal
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.style.display === 'block') {
      setFilterSettingsOpen(false);
    }
  });

  bindSettingsMenuFocusTrap(modal);
}

// Function to create settings menu
async function createSettingsMenu(): Promise<void> {
  if (document.querySelector('#alienware-filter-settings')) {
    setFilterSettingsOpen(false);
    return;
  }

  const settings = await getSettings();
  document.body.insertAdjacentHTML(
    'beforeend',
    buildSettingsMenuHTML(settings),
  );

  const modal = getFilterSettingsModal();
  if (!modal) {
    return;
  }

  // Always start closed — inline style beats accidental stylesheet races.
  setFilterSettingsOpen(false);
  bindSettingsMenuEvents(modal);
}

// Function to add settings button to menu
function addSettingsButton(): void {
  const menuList = document.querySelector<HTMLElement>(
    '.nav-item-mus .dropdown-menu.dropdown-menu-end',
  );
  if (!menuList || menuList.querySelector('[data-filter-settings-menu]')) {
    return;
  }
  const settingsItem = document.createElement('a');
  settingsItem.className = 'dropdown-item';
  settingsItem.href = '#';
  settingsItem.dataset.filterSettingsMenu = '1';
  settingsItem.textContent = 'Filter Settings';
  settingsItem.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setFilterSettingsOpen(true);
  });
  menuList.insertBefore(settingsItem, menuList.lastElementChild);
}

function watchSettingsButton(): void {
  addSettingsButton();
  if (document.documentElement.dataset.awaFilterMenuWatch === '1') {
    return;
  }
  document.documentElement.dataset.awaFilterMenuWatch = '1';
  const observer = new MutationObserver(() => {
    if (!document.querySelector('[data-filter-settings-menu]')) {
      addSettingsButton();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

// Initialize everything based on current page
const currentPath = location.pathname;

ensureFilterStyles();

// Paint optimizer chrome immediately; settings menu GM read must not delay it.
void initArtifactOptimizer();
await waitForBody();
await createSettingsMenu();
watchSettingsButton();

// UCF post reading mode
await initUcfReadingMode();

const settings = await getSettings();
if (settings.autoSyncTier) {
  await checkAndStoreTier();
}

if (currentPath === '/community-giveaways') {
  const observer = new MutationObserver(() => {
    void filterGiveaways();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
  await filterGiveaways();
} else if (currentPath.startsWith('/marketplace')) {
  const observer = new MutationObserver(() => {
    void filterMarketplace();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
  await filterMarketplace();
}
