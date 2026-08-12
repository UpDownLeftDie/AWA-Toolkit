import {
  defaultSettings,
  getSettings,
  isFilterMode,
  saveSettings,
  type FilterMode,
  type FilterSettings,
} from './settings';

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

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.style.display === 'block') {
      setFilterSettingsOpen(false);
    }
  });

  bindSettingsMenuFocusTrap(modal);
}

export async function createSettingsMenu(): Promise<void> {
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

  setFilterSettingsOpen(false);
  bindSettingsMenuEvents(modal);
}

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

export function watchSettingsButton(): void {
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
