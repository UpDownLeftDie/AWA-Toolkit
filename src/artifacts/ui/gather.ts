import { GM } from '$';
import {
  applyAsceCommunityHours,
  didRefreshAsceCommunityHours,
  hasPendingAsceRefresh,
} from '../asce';
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
  getArtifactSettings,
  syncSlotLocksFromScrape,
  type ArtifactOptimizerSettings,
} from '../settings';
import {
  applyLiveDocumentToSiteState,
  emptySiteState,
  loadSiteState,
  refreshSiteStateFromPage,
  saveSiteState,
  type SiteState,
} from '../siteState';
import { requiresSteamFreeHydrate } from '../steamApp';

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

function loadCachedOrRemoteSnapshot(
  isRemote: boolean,
  options: { force?: boolean } = {},
): Promise<ArtifactSnapshot | undefined> {
  if (isRemote) {
    return ensureArtifactSnapshot({ force: options.force === true });
  }
  return loadSnapshot();
}

function assertGmStorage(): void {
  if (typeof GM?.getValue !== 'function') {
    throw new TypeError(
      'GM storage is unavailable. For pnpm run dev, install the userscript served at http://localhost:3000 (named server:AWA Toolkit). A custom stub that only @requires that file does not get @grant, so recommendations never load.',
    );
  }
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
  const snapshotPromise =
    !shouldForceSite && isArtifactsShowroomPage()
      ? scrapeAndPersist()
      : loadCachedOrRemoteSnapshot(isRemote || isArtifactsShowroomPage(), {
          force: shouldForceSite,
        });
  const siteStatePromise = isRemote
    ? ensureSiteState({ force: shouldForceSite })
    : loadSiteState();

  const [snapshot, loadedState] = await Promise.all([
    snapshotPromise,
    siteStatePromise,
  ]);
  // Re-apply Showroom lock icons every gather — including cache-only loads.
  // Otherwise stale GM timers survive browser refresh while snapshot.slotLocks
  // already knows slots are open.
  if (snapshot?.slotLocks) {
    await syncSlotLocksFromScrape(snapshot.slotLocks);
  }
  const settings = await getArtifactSettings();

  let siteState: SiteState = loadedState ?? emptySiteState();
  if (isSiteStatePage()) {
    if (isRemote) {
      siteState = await refreshSiteStateFromPage();
      await applyAsceCommunityHours(siteState);
    } else {
      applyLiveDocumentToSiteState(siteState);
    }
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
  return rememberGathered({ snapshot, settings, siteState, result });
}

export type GatheredData = Awaited<ReturnType<typeof gatherData>>;

export const gatheredCache: { current?: GatheredData } = {};

export function rememberGathered(data: GatheredData): GatheredData {
  gatheredCache.current = data;
  return data;
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
  if (!state.communityEvent?.isLive) {
    return false;
  }
  return (
    state.communityEvent.communityHoursSource !== 'asce' ||
    hasPendingAsceRefresh()
  );
}

export function requiresBackgroundHydrate(
  data: GatheredData,
  options: { force?: boolean } = {},
): boolean {
  if (options.force) {
    return true;
  }
  if (
    !isArtifactsShowroomPage() &&
    requiresRemoteSnapshotHydrate(data.snapshot)
  ) {
    return true;
  }
  if (requiresRemoteSiteHydrate(data.siteState)) {
    return true;
  }
  if (requiresSteamFreeHydrate(data.siteState)) {
    return true;
  }
  return requiresAsceHydrate(data.siteState);
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
