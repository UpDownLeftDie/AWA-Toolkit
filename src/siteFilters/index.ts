import { ensureFilterStyles, watchPageFilters } from './apply';
import { createSettingsMenu, watchSettingsButton } from './dialog';
import { checkAndStoreTier, getSettings } from './settings';

export async function initFilters(): Promise<void> {
  ensureFilterStyles();
  await createSettingsMenu();
  watchSettingsButton();

  const settings = await getSettings();
  if (settings.autoSyncTier) {
    await checkAndStoreTier();
  }

  watchPageFilters();
}
