import { GM } from '$';

export type FilterMode = 'off' | 'dim' | 'hide';

export interface FilterSettings {
  higherTier: FilterMode;
  autoSyncTier: boolean;
  outOfStock: FilterMode;
  claimed: FilterMode;
  closedGiveaways: FilterMode;
  enteredGiveaways: FilterMode;
  userTier?: number;
}

export const DEFAULT_USER_TIER = 99;

export const defaultSettings: FilterSettings = {
  higherTier: 'hide',
  autoSyncTier: true,
  outOfStock: 'hide',
  claimed: 'hide',
  closedGiveaways: 'hide',
  enteredGiveaways: 'hide',
};

const FILTER_MODES = new Set<string>(['off', 'dim', 'hide']);

export function isFilterMode(value: unknown): value is FilterMode {
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

export async function getSettings(): Promise<FilterSettings> {
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

export async function saveSettings(
  settings: Partial<FilterSettings>,
): Promise<void> {
  const previousSettings = await getSettings();
  const newSettings = {
    ...previousSettings,
    ...settings,
  };
  await GM.setValue('filterSettings', JSON.stringify(newSettings));
}

export function extractTier(text: string): number | undefined {
  const match = /Tier\s*(\d+)/i.exec(text);
  if (match?.[1]) {
    return Number(match[1]);
  }
  return undefined;
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

export async function checkAndStoreTier(): Promise<void> {
  const userTier = readPageUserTier();
  if (userTier === undefined) {
    return;
  }

  await saveSettings({ userTier });
  console.log('Stored user tier:', userTier);
}
