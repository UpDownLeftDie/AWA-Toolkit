import { GM } from "$";
import { resolveSiteStateSteamFreeToPlay } from "../steamApp";
import {
  applyRedeemableArpFromDocument,
  arpLogSignature,
  isArpLogDocumentReady,
  mergeArpLogScrape,
  scrapeArpLogFromDocument,
  waitForArpLogDocument,
} from "./arpLog";
import {
  applyBattlePassEndFromDocument,
  battlePassClaimSignature,
  isBattlePassDocumentReady,
  mergeBattlePassScrape,
  scrapeBattlePass,
  waitForBattlePassDocument,
} from "./battlePass";
import {
  applyArpLogActivityCaps,
  controlCenterActivitySignature,
  isControlCenterActivityReady,
  isControlCenterDocumentReady,
  scrapeControlCenterCaps,
  scrapeWatchTwitchProgressFromDocument,
  waitForControlCenterDocument,
} from "./caps";
import {
  mergeCommunityEventScrape,
  reconcileCommunityEventWithArpLog,
  scrapeCommunityEventFromDocument,
  scrapeLiveCommunityEventBanner,
} from "./communityEvent";
import { applyDailyQuestsFromDocument } from "./dailyQuests";
import {
  applyGameVaultDocument,
  scrapeUserArpTierFromDocument,
} from "./gameVault";
import {
  applySteamQuestDetailFromDocument,
  applySteamQuestsFromDocument,
  steamQuestsCapFromRows,
} from "./steamQuests";
import type {
  ActivityCapState,
  ActivityKey,
  CapStatus,
  SiteState,
} from "./types";

const SITE_STATE_KEY = "artifactSiteState";

const DEFAULT_CAPS: ActivityCapState = {
  timeOnSite: "unknown",
  steamQuests: "unknown",
  watchTwitch: "unknown",
  dailyCalendar: "unknown",
  discordPoll: "unknown",
  dailyQuests: "unknown",
  steamCommunityEvent: "unknown",
};

function normalizeCaps(raw: unknown): ActivityCapState {
  const caps = (raw ?? {}) as Partial<ActivityCapState> & {
    communityEvent?: CapStatus;
  };
  return {
    ...DEFAULT_CAPS,
    ...caps,
    dailyQuests: caps.dailyQuests ?? caps.communityEvent ?? "unknown",
    steamCommunityEvent: caps.steamCommunityEvent ?? "unknown",
  };
}

function isSiteState(value: unknown): value is SiteState {
  return typeof value === "object" && !!value && "caps" in value;
}

export async function loadSiteState(): Promise<SiteState | undefined> {
  const raw: string | SiteState | undefined = await GM.getValue(SITE_STATE_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isSiteState(parsed)) {
      return undefined;
    }
    return {
      ...parsed,
      caps: normalizeCaps(parsed.caps),
    };
  } catch {
    return undefined;
  }
}

export async function saveSiteState(state: SiteState): Promise<void> {
  await GM.setValue(SITE_STATE_KEY, JSON.stringify(state));
}

function applyWatchTwitchFromDocument(
  next: SiteState,
  document_: Document,
): void {
  const progress = scrapeWatchTwitchProgressFromDocument(
    document_,
    next.watchTwitch,
  );
  if (progress) {
    next.watchTwitch = progress;
  }
}

function applyControlCenterPage(next: SiteState): void {
  if (!isControlCenterDocumentReady(document)) {
    return;
  }
  Object.assign(next.caps, scrapeControlCenterCaps());
  applySteamQuestsFromDocument(next, document);
  applyDailyQuestsFromDocument(next, document);
  applyWatchTwitchFromDocument(next, document);
  applyBattlePassEndFromDocument(next, document);
  const banner = scrapeLiveCommunityEventBanner(document);
  if (banner) {
    next.caps.steamCommunityEvent = "available";
    if (next.communityEvent && !next.communityEvent.isLive) {
      next.communityEvent = {
        ...next.communityEvent,
        isLive: true,
        url: banner.url,
        ...(banner.title &&
          next.communityEvent.title === undefined && { title: banner.title }),
      };
    }
    return;
  }
  // Banner miss is not proof the event ended — widgets can paint first.
  // Keep a live cached event; the event-page scrape is what ends it.
  if (!next.communityEvent?.isLive) {
    next.caps.steamCommunityEvent = "capped";
  }
}

function applyCommunityEventPage(next: SiteState): void {
  const scraped = scrapeCommunityEventFromDocument(document, location.pathname);
  const event = mergeCommunityEventScrape(scraped, next.communityEvent, {
    source: "visit",
  });
  next.communityEvent = event;
  next.caps.steamCommunityEvent = event.isLive ? "available" : "capped";
}

export function applyLiveDocumentToSiteState(next: SiteState): void {
  const path = location.pathname;

  const userArpTier = scrapeUserArpTierFromDocument(document);
  if (userArpTier !== undefined) {
    next.userArpTier = userArpTier;
  }
  applyRedeemableArpFromDocument(next, document);

  if (path.includes("/control-center") && !path.includes("/battle-pass")) {
    applyControlCenterPage(next);
  }

  if (
    path.includes("/steam/questsetup") ||
    path.includes("/rewards/terms") ||
    path.includes("/faq-contact")
  ) {
    applyWatchTwitchFromDocument(next, document);
  }

  if (path.includes("/marketplace") || path.includes("/game-vault")) {
    applyGameVaultDocument(next, document);
  }

  if (path.includes("/battle-pass")) {
    const battlePass = scrapeBattlePass();
    if (battlePass) {
      next.battlePass = mergeBattlePassScrape(battlePass, next.battlePass);
    }
  }

  if (path.includes("/arp-log") && isArpLogDocumentReady(document)) {
    // The page defaults to its 10 most recent rows unless the user added
    // from/to params — merge so a plain visit doesn't clobber a wider
    // background-fetched window. Skip before the table exists: an empty
    // scrape would still stamp scrapedAt and hide a just-cast Discord vote.
    next.arpLog = mergeArpLogScrape(
      scrapeArpLogFromDocument(document),
      next.arpLog,
    );
  }

  if (path.includes("/steam/community-event")) {
    applyCommunityEventPage(next);
  }

  if (/\/steam\/quests\/.+/.test(path)) {
    applySteamQuestDetailFromDocument(next, document, path);
  }

  next.caps = applyArpLogActivityCaps(next.caps, next.arpLog);

  if (next.communityEvent) {
    next.communityEvent = reconcileCommunityEventWithArpLog(
      next.communityEvent,
      next.arpLog,
    );
  }
}

export async function refreshSiteStateFromPage(): Promise<SiteState> {
  const previous = (await loadSiteState()) ?? {
    updatedAt: new Date().toISOString(),
    caps: { ...DEFAULT_CAPS },
    gameVault: [],
  };

  if (location.pathname.includes("/arp-log")) {
    await waitForArpLogDocument();
  }
  if (
    location.pathname.includes("/control-center") &&
    !location.pathname.includes("/battle-pass")
  ) {
    await waitForControlCenterDocument();
  }

  const next: SiteState = {
    ...previous,
    updatedAt: new Date().toISOString(),
    caps: { ...previous.caps },
  };
  applyLiveDocumentToSiteState(next);
  await saveSiteState(next);
  return next;
}

/**
 * `onPersist` runs after every persisted refresh (e.g. ASCE hours) — caller
 * hook instead of importing `asce.ts` here (circular with this module).
 */
function watchLiveSiteStatePage(options: {
  isPage: boolean;
  datasetFlag: "aoBpWatch" | "aoCcWatch" | "aoArpWatch";
  isReady: (document_: Document) => boolean;
  signature: (document_: Document) => string;
  waitForReady: () => Promise<void>;
  onPersist?: (state: SiteState) => void | Promise<void>;
  clickSelector?: string;
}): void {
  if (!options.isPage) {
    return;
  }
  if (document.documentElement.dataset[options.datasetFlag] === "1") {
    return;
  }
  document.documentElement.dataset[options.datasetFlag] = "1";

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSignature = "";
  let isPersisting = false;
  let isPendingAfterPersist = false;

  const persistIfChanged = async (): Promise<void> => {
    if (!options.isReady(document)) {
      return;
    }
    const signature = options.signature(document);
    if (signature === lastSignature) {
      return;
    }
    if (isPersisting) {
      isPendingAfterPersist = true;
      return;
    }
    isPersisting = true;
    try {
      const state = await refreshSiteStateFromPage();
      lastSignature = signature;
      await options.onPersist?.(state);
    } finally {
      isPersisting = false;
      if (isPendingAfterPersist) {
        isPendingAfterPersist = false;
        void persistIfChanged();
      }
    }
  };

  const schedule = (): void => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void persistIfChanged();
    }, 250);
  };

  void (async () => {
    await options.waitForReady();
    await persistIfChanged();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    if (!options.clickSelector) {
      return;
    }
    const clickSelector = options.clickSelector;
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        if (target.closest(clickSelector)) {
          schedule();
        }
      },
      { capture: true },
    );
  })();
}

/**
 * Keep Battle Pass ready-to-claim counts in sync while the user claims on the
 * live page (CLAIM buttons disappear / COMPLETE markers appear).
 */
export function watchBattlePassPage(
  onPersist?: (state: SiteState) => void | Promise<void>,
): void {
  watchLiveSiteStatePage({
    isPage: location.pathname.includes("/battle-pass"),
    datasetFlag: "aoBpWatch",
    isReady: isBattlePassDocumentReady,
    signature: battlePassClaimSignature,
    waitForReady: waitForBattlePassDocument,
    ...(onPersist && { onPersist }),
    clickSelector: ".bp-popup__claim-btn",
  });
}

/**
 * Keep Control Center caps / Watch Twitch in sync while the user stays on the
 * page (jQuery fills empty SSR spans; twitch ticks update status text).
 */
export function watchControlCenterPage(
  onPersist?: (state: SiteState) => void | Promise<void>,
): void {
  watchLiveSiteStatePage({
    isPage:
      location.pathname.includes("/control-center") &&
      !location.pathname.includes("/battle-pass"),
    datasetFlag: "aoCcWatch",
    isReady: isControlCenterActivityReady,
    signature: controlCenterActivitySignature,
    waitForReady: waitForControlCenterDocument,
    ...(onPersist && { onPersist }),
  });
}

/**
 * Persist Discord Poll / calendar earns when the ARP Log table paints.
 * `@run-at document-start` otherwise stamps an empty scrape as fresh.
 */
export function watchArpLogPage(
  onPersist?: (state: SiteState) => void | Promise<void>,
): void {
  watchLiveSiteStatePage({
    isPage: location.pathname.includes("/arp-log"),
    datasetFlag: "aoArpWatch",
    isReady: isArpLogDocumentReady,
    signature: arpLogSignature,
    waitForReady: waitForArpLogDocument,
    ...(onPersist && { onPersist }),
  });
}

export async function applySteamFreeToPlayResolution(
  next: SiteState,
): Promise<void> {
  await resolveSiteStateSteamFreeToPlay(next);
  const cap = steamQuestsCapFromRows(next.steamQuests?.quests ?? []);
  if (cap) {
    next.caps.steamQuests = cap;
  }
}

export function emptySiteState(): SiteState {
  return {
    updatedAt: new Date(0).toISOString(),
    caps: { ...DEFAULT_CAPS },
    gameVault: [],
  };
}

/**
 * Treat unknown as still available (optimistic for planning).
 */
export function isActivityAvailable(
  caps: ActivityCapState,
  key: ActivityKey,
): boolean {
  return caps[key] !== "capped";
}

/**
 * True when the user still needs to claim/complete this activity soon.
 * Weekly activities default to pending when status is unknown — except Discord
 * Poll, which is often absent from Control Center markup (use ARP Log instead).
 */
export function isActivityPending(
  caps: ActivityCapState,
  key: ActivityKey,
): boolean {
  const status = caps[key];
  if (status === "available") {
    return true;
  }
  if (status === "capped") {
    return false;
  }
  return (
    ["steamQuests", "dailyQuests", "steamCommunityEvent"] as ActivityKey[]
  ).includes(key);
}

export type {
  ActivityKey,
  ActivityCapState,
  CapStatus,
  SiteState,
} from "./types";
export type { WatchTwitchProgress } from "./caps";
export {
  scrapeWatchTwitchProgressFromDocument,
  twitchWatchRemainingMs,
  hasVotedCurrentDiscordPoll,
  applyArpLogActivityCaps,
  scrapeControlCenterCapsFromDocument,
  scrapeControlCenterCaps,
  isControlCenterActivityReady,
  isControlCenterDocumentReady,
  waitForControlCenterDocument,
} from "./caps";
export { utcDateString } from "./shared";
export type {
  DailyQuestKind,
  DailyQuestRow,
  DailyQuestsState,
} from "./dailyQuests";
export {
  applyDailyQuestsFromDocument,
  dailyQuestsCapFromRows,
  remainingDailyQuestRows,
  scrapeDailyQuestRowsFromDocument,
} from "./dailyQuests";
export type {
  SteamPlayEligibility,
  SteamQuestRow,
  SteamQuestsState,
} from "./steamQuests";
export {
  isChooseYourOwnGameQuest,
  scrapeSteamQuestRowsFromDocument,
  steamQuestsCapFromRows,
  remainingSteamQuestRows,
  remainingSteamQuestRewards,
  scrapedRemainingSteamQuestRewards,
  requiresSteamQuestEligibilityFetch,
  scrapeSteamPlayEligibilityFromDocument,
  applySteamQuestsFromDocument,
  applySteamQuestDetailFromDocument,
} from "./steamQuests";
export type {
  CommunityEventMilestone,
  CommunityEventState,
  CommunityHoursSample,
  CommunityEventMilestoneGate,
  CommunityEventPendingBreakdown,
  CommunityHoursSampleSource,
  CommunityUnlockEstimate,
  ReachableCommunityUnlock,
  WaitingCommunityArpDescription,
} from "./communityEvent";
export {
  canEarnCommunityEventArp,
  scrapeLiveCommunityEventBanner,
  isCommunityEventMilestonePending,
  isCommunityGateMet,
  isPersonalHoursMet,
  computePendingCommunityEventArp,
  breakDownCommunityEventPending,
  describeCommunityEventPending,
  describeCommunityEventPendingParts,
  COMMUNITY_HOURS_REMOTE_SAMPLE_MIN_MS,
  markCommunityEventEnded,
  appendCommunityHoursSample,
  mergeCommunityEventScrape,
  upsertCommunityEventMilestoneGates,
  applyCommunityHoursUnlocks,
  applySequentialCommunityAwards,
  nextCommunityUnlockTarget,
  nextWaitingCommunityMilestone,
  waitingCommunityMilestones,
  nextLockedCommunityArpMilestone,
  lockedCommunityArpMilestones,
  nextReachableCommunityUnlock,
  formatCommunityEventArp,
  describeWaitingCommunityArp,
  describeWaitingCommunityArpLine,
  estimateCommunityUnlockAt,
  estimateNextCommunityUnlock,
  formatCommunityEta,
  describeWaitingCommunityProgress,
  computeAwardedCommunityEventArp,
  isCommunityEventRewardAction,
  sumCommunityEventRewardsFromArpLog,
  reconcileCommunityEventWithArpLog,
  parseCommunityEventPersonalHours,
  parseCommunityEventProgress,
  scrapeCommunityEventFromDocument,
  scrapeCommunityEvent,
} from "./communityEvent";
export type { GameVaultItem } from "./gameVault";
export {
  vaultPayArp,
  vaultGamePayArp,
  canAffordVaultPrice,
  isAffordableVaultOffer,
  hasPostedListPriceVaultGames,
  canAffordAnyVaultOffer,
  isClaimableVaultGame,
  isGameVaultStockOpen,
  isGameVaultCurrentlyOpen,
  GAME_VAULT_EQUIP_BUFFER_MS,
  gameVaultCycleId,
  gameVaultOpensAtMs,
  willMissDiscountEquipBeforeOpen,
  gameVaultCatalogPrice,
  scrapeGameVaultTimerMsFromDocument,
  scrapeGameVaultFromDocument,
  scrapeGameVault,
  scrapeUserArpTierFromDocument,
  applyGameVaultDocument,
} from "./gameVault";
export type { BattlePassReadyClaim, BattlePassState } from "./battlePass";
export {
  scrapeBattlePassFromDocument,
  parseBattlePassCountdownMs,
  battlePassRemainingMs,
  mergeBattlePassScrape,
  applyBattlePassEndFromDocument,
  battlePassClaimableArp,
  battlePassReadyNonArp,
  shouldShowBattlePassClaimAll,
  shouldSkipArpInBattlePassClaimAll,
  battlePassClaimButtonLabel,
  scrapeBattlePass,
  isBattlePassDocumentReady,
  waitForBattlePassDocument,
  listBattlePassClaimButtons,
  claimAllBattlePassRewards,
} from "./battlePass";
export type { ArpLogEntry, ArpLogState } from "./arpLog";
export {
  scrapeRedeemableArpFromDocument,
  applyRedeemableArpFromDocument,
  scrapeArpLogFromDocument,
  mergeArpLogScrape,
  isArpLogDocumentReady,
  arpLogSignature,
  waitForArpLogDocument,
} from "./arpLog";
