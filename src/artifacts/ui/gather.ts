import { GM } from '$';
import {
  ensureAchievementSnapshot,
  isAchievementsPage,
  loadAchievementSnapshot,
  requiresAchievementHydrate,
  runAchievementAutomations,
  saveAchievementSnapshot,
  scrapeAchievementsFromDocument,
  waitForAchievementsDocument,
  type AchievementSnapshot,
} from '../../achievements/scraper';
import {
  getAchievementSettings,
  loadAutomationCooldowns,
  type AchievementSettings,
  type AutomationCooldowns,
} from '../../achievements/settings';
import {
  applyAsceCommunityHours,
  didRefreshAsceCommunityHours,
  hasPendingAsceRefresh,
} from '../asce';
import { scheduleBrowserNotifications } from '../notifications';
import { buildContext, optimize, type OptimizerResult } from '../optimizer';
import {
  ensureArtifactSnapshot,
  ensureSiteState,
  requiresRemoteSiteHydrate,
  requiresRemoteSnapshotHydrate,
} from '../remoteScrape';
import {
  isArtifactsShowroomPage,
  loadSnapshot,
  scrapeAndPersist,
  type ArtifactSnapshot,
} from '../scraper';
import {
  isAchievementsHelperFeatureEnabled,
  getArtifactSettings,
  hasElapsedShowroomLock,
  syncSlotLocksFromScrape,
  type ArtifactOptimizerSettings,
} from '../settings';
import {
  applyLiveDocumentToSiteState,
  battlePassControlCenterPath,
  discoverBattlePassPath,
  emptySiteState,
  loadSiteState,
  refreshSiteStateFromPage,
  saveSiteState,
  type SiteState,
} from '../siteState';
import { requiresSteamFreeHydrate } from '../steamApp';
import { attachLoadoutDisplayOrder } from './loadoutPlan';

export function isControlCenterPage(): boolean {
  let path = location.pathname;
  while (path.endsWith('/') && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path.endsWith('/control-center');
}

export function isSiteStatePage(): boolean {
  const path = location.pathname;
  return (
    path.includes('/control-center') ||
    path.includes('/marketplace') ||
    path.includes('/game-vault') ||
    path.includes('/battle-pass') ||
    path.includes('/arp-log') ||
    path.includes('/steam/community-event')
  );
}

/**
 * Live Showroom scrapes skip ensureArtifactSnapshot, so they never POST
 * Megumin's 0-frag upgrade. If the GM timer is already 0 and the page still
 * shows locked, Force-Refresh that path once before optimizing.
 */
async function snapshotAfterElapsedShowroomLock(
  snapshot: ArtifactSnapshot | undefined,
  settings: ArtifactOptimizerSettings,
  options: { isRemote: boolean; shouldForceSite: boolean },
): Promise<{
  snapshot: ArtifactSnapshot | undefined;
  settings: ArtifactOptimizerSettings;
}> {
  if (
    options.shouldForceSite ||
    !options.isRemote ||
    !isArtifactsShowroomPage() ||
    !hasElapsedShowroomLock(settings, snapshot?.slotLocks)
  ) {
    return { snapshot, settings };
  }
  const refreshed = await ensureArtifactSnapshot({ force: true });
  const nextSnapshot = refreshed ?? snapshot;
  if (nextSnapshot?.slotLocks) {
    await syncSlotLocksFromScrape(nextSnapshot.slotLocks);
  }
  return {
    snapshot: nextSnapshot,
    settings: await getArtifactSettings(),
  };
}

export function hasGmStorage(): boolean {
  return typeof GM?.getValue === 'function';
}

function assertGmStorage(): void {
  if (!hasGmStorage()) {
    throw new TypeError(
      'GM storage is unavailable. For pnpm run dev, install the userscript served at http://localhost:3000 (named server:AWA Toolkit). A custom stub that only @requires that file does not get @grant, so recommendations never load.',
    );
  }
}

async function gatherAchievements(options: {
  isRemote: boolean;
  shouldForceSite: boolean;
  username: string | undefined;
  settings: ArtifactOptimizerSettings;
  achievementSettings: AchievementSettings;
}): Promise<AchievementSnapshot | undefined> {
  if (!isAchievementsHelperFeatureEnabled || !options.settings.achievementsEnabled) {
    return undefined;
  }
  if (isAchievementsPage()) {
    await waitForAchievementsDocument();
    let achievements = scrapeAchievementsFromDocument(
      document,
      options.username === undefined ? {} : { username: options.username },
    );
    await saveAchievementSnapshot(achievements);
    achievements = await runAchievementAutomations(
      achievements,
      options.achievementSettings,
    );
    await saveAchievementSnapshot(achievements);
    return achievements;
  }
  if (options.isRemote) {
    const ensureOptions: { force: boolean; username?: string } = {
      force: options.shouldForceSite,
    };
    if (options.username !== undefined) {
      ensureOptions.username = options.username;
    }
    return ensureAchievementSnapshot(ensureOptions);
  }
  return loadAchievementSnapshot();
}

export async function gatherData(options?: {
  /**
  When true, fetch/open Showroom & site pages if cached data is missing/stale.
  */
  remote?: boolean;
  /**
  When true, re-fetch Control Center / Battle Pass / event pages even if fresh.
  */
  forceSite?: boolean;
}): Promise<{
  snapshot: ArtifactSnapshot | undefined;
  settings: ArtifactOptimizerSettings;
  siteState: SiteState;
  result: OptimizerResult;
  achievements: AchievementSnapshot | undefined;
  achievementSettings: AchievementSettings;
  achievementCooldowns: AutomationCooldowns;
}> {
  assertGmStorage();
  const isRemote = options?.remote ?? true;
  // Force Refresh always re-fetches; scrapes merge into cached state (ASCE
  // hours, samples, eligibility) rather than replacing blindly.
  const shouldForceSite = options?.forceSite === true;

  // Snapshot scrape syncs slot lock icons into settings — load settings only
  // after that finishes, or Refresh can paint stale cooldowns.
  // On the Showroom page, still go through ensureArtifactSnapshot so Force
  // Refresh can run the stuck-lock nudge before scraping.
  let snapshotPromise: Promise<ArtifactSnapshot | undefined>;
  if (!shouldForceSite && isArtifactsShowroomPage()) {
    snapshotPromise = scrapeAndPersist();
  } else if (isRemote || isArtifactsShowroomPage()) {
    snapshotPromise = ensureArtifactSnapshot({ force: shouldForceSite });
  } else {
    snapshotPromise = loadSnapshot();
  }
  const siteStatePromise = isRemote
    ? ensureSiteState({ force: shouldForceSite })
    : loadSiteState();

  const [loadedSnapshot, loadedState] = await Promise.all([
    snapshotPromise,
    siteStatePromise,
  ]);
  // Re-apply Showroom lock icons every gather — including cache-only loads.
  // Otherwise stale GM timers survive browser refresh while snapshot.slotLocks
  // already knows slots are open.
  if (loadedSnapshot?.slotLocks) {
    await syncSlotLocksFromScrape(loadedSnapshot.slotLocks);
  }
  const afterLocks = await snapshotAfterElapsedShowroomLock(
    loadedSnapshot,
    await getArtifactSettings(),
    {
      isRemote,
      shouldForceSite,
    },
  );
  const snapshot = afterLocks.snapshot;
  const settings = afterLocks.settings;
  const achievementSettings = await getAchievementSettings();
  const achievements = await gatherAchievements({
    isRemote,
    shouldForceSite,
    username: snapshot?.username,
    settings,
    achievementSettings,
  });
  // Load after automations so "done today" filtering matches what just ran.
  const achievementCooldowns = await loadAutomationCooldowns();

  let siteState: SiteState = loadedState ?? emptySiteState();
  if (isSiteStatePage()) {
    if (isRemote) {
      siteState = await refreshSiteStateFromPage();
    } else {
      applyLiveDocumentToSiteState(siteState);
    }
  }
  await applyAsceCommunityHours(siteState);
  if (isSiteStatePage()) {
    await saveSiteState(siteState);
  }

  const emptySnapshot: ArtifactSnapshot = {
    scrapedAt: new Date(0).toISOString(),
    username: undefined,
    fragments: settings.manualFragments ?? 0,
    artifacts: [],
  };

  const result = optimize(
    buildContext(snapshot ?? emptySnapshot, settings, siteState),
  );
  return rememberGathered({
    snapshot,
    settings,
    siteState,
    result,
    achievements,
    achievementSettings,
    achievementCooldowns,
  });
}

export type GatheredData = Awaited<ReturnType<typeof gatherData>>;

export const gatheredCache: { current?: GatheredData } = {};

export function rememberGathered(data: GatheredData): GatheredData {
  attachLoadoutDisplayOrder(data.result, data.settings);
  gatheredCache.current = data;
  scheduleBrowserNotifications(data);
  return data;
}

/**
 * Cache-only gather so a background AWA tab can arm notification timers.
 * Skips when GM is missing (dev HMR / stub without @grant) so we do not
 * paint the panel error on pages that never needed a gather.
 */
export async function warmNotificationSchedule(): Promise<void> {
  if (!hasGmStorage() || gatheredCache.current) {
    return;
  }
  try {
    const settings = await getArtifactSettings();
    if (!settings.browserNotifications) {
      return;
    }
    await gatherData({ remote: false });
  } catch {
    // Inject / Open Full Panel will gather once GM is ready.
  }
}

export function snapshotForOptimize(data: GatheredData): ArtifactSnapshot {
  return (
    data.snapshot ?? {
      scrapedAt: new Date(0).toISOString(),
      username: undefined,
      fragments: data.settings.manualFragments ?? 0,
      artifacts: [],
    }
  );
}

function requiresAsceHydrate(state: SiteState): boolean {
  return (
    state.communityEvent?.isLive === true &&
    (state.communityEvent.communityHoursSource !== 'asce' ||
      hasPendingAsceRefresh())
  );
}

export function requiresBackgroundHydrate(
  data: GatheredData,
  options: { force?: boolean } = {},
): boolean {
  if (options.force) {
    return true;
  }
  // Timer elapsed + Showroom still locked: hydrate so we can run Megumin's
  // 0-frag upgrade even when the snapshot is otherwise "fresh".
  if (hasElapsedShowroomLock(data.settings, data.snapshot?.slotLocks)) {
    return true;
  }
  if (
    !isArtifactsShowroomPage() &&
    requiresRemoteSnapshotHydrate(data.snapshot)
  ) {
    return true;
  }
  return (
    requiresRemoteSiteHydrate(data.siteState) ||
    requiresSteamFreeHydrate(data.siteState) ||
    (isAchievementsHelperFeatureEnabled &&
      data.settings.achievementsEnabled &&
      requiresAchievementHydrate(
        data.achievements,
        data.settings.achievementsEnabled,
      )) ||
    requiresAsceHydrate(data.siteState)
  );
}

/*
Cached state still points at an ended pass (`/battle-pass/1` after `/2` is live).
*/
export async function requiresSeasonChangeHydrate(
  state: SiteState | undefined,
): Promise<boolean> {
  const path = await discoverBattlePassPath({
    knownUrl: state?.battlePass?.url,
  });
  return (
    path !== undefined &&
    path !== battlePassControlCenterPath(state?.battlePass?.url)
  );
}

async function hydrateAsceData(
  data: GatheredData,
  options: { force?: boolean } = {},
): Promise<GatheredData | undefined> {
  if (!data.siteState.communityEvent?.isLive) {
    return;
  }
  const hasAsceHoursChanged = await didRefreshAsceCommunityHours(
    data.siteState,
    { force: options.force === true },
  );
  if (!hasAsceHoursChanged) {
    return;
  }
  await saveSiteState(data.siteState);
  const asceResult = optimize(
    buildContext(snapshotForOptimize(data), data.settings, data.siteState),
  );
  return rememberGathered({ ...data, result: asceResult });
}

export async function hydrateGatheredData(
  options: { force?: boolean } = {},
): Promise<GatheredData> {
  const remote = await gatherData({
    remote: true,
    forceSite: options.force === true,
  });
  const asce = await hydrateAsceData(remote, { force: options.force === true });
  return asce ?? remote;
}
