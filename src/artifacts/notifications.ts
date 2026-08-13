import { GM } from "$";

import type { OptimizerResult } from "./optimizer";
import {
  loadOfficialGiveaways,
  OFFICIAL_GIVEAWAYS_PATH,
} from "./officialGiveaways";
import {
  getArtifactSettings,
  isNotificationTypeEnabled,
  saveArtifactSettings,
  type ArtifactOptimizerSettings,
  type NotificationTypeKey,
} from "./settings";
import {
  breakDownCommunityEventPending,
  canEarnCommunityEventArp,
  estimateNextCommunityUnlock,
  formatCommunityEventArp,
  gameVaultCycleId,
  gameVaultOpensAtMs,
  type GameVaultItem,
  type SiteState,
} from "./siteState";
import {
  isSameLoadout,
  loadoutLabel,
  planLoadoutChanges,
} from "./ui/loadoutPlan";

const NOTIFY_LOG_KEY = "artifactOptimizerNotifyLog";
const NOTIFY_ICON =
  "https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/icon.png";
const NOTIFY_TITLE = "AWA Toolkit";
const FIRED_KEEP_MS = 48 * 60 * 60 * 1000;
/**
 * Keep a shown notification after the tab dies (Violentmonkey). Tampermonkey
 * uses `tag` + `url` for the same persistence.
 */
const ZOMBIE_MS = 24 * 60 * 60 * 1000;
const SHOWROOM_PATH = "/user-artifacts-room";
const VAULT_PATH = "/game-vault";
const CONTROL_CENTER_PATH = "/control-center";

export type NotificationSource = {
  settings: ArtifactOptimizerSettings;
  result: OptimizerResult;
  siteState: SiteState;
};

type NotifyKind = "swap" | "vault" | "community" | "giveaway";

function absoluteAwaUrl(pathOrUrl: string): string {
  return new URL(pathOrUrl, location.origin).href;
}

function notifyUrlForKind(kind: NotifyKind): string {
  if (kind === "swap") {
    return absoluteAwaUrl(SHOWROOM_PATH);
  }
  if (kind === "vault") {
    return absoluteAwaUrl(VAULT_PATH);
  }
  if (kind === "giveaway") {
    return absoluteAwaUrl(OFFICIAL_GIVEAWAYS_PATH);
  }
  return absoluteAwaUrl(CONTROL_CENTER_PATH);
}

interface ScheduledNotify {
  id: string;
  kind: NotifyKind;
  fireAt: number;
  title: string;
  body: string;
  url: string;
  artifactIds?: number[];
  cycleId?: string;
  targetHours?: number;
}

interface NotifyLog {
  scheduled: Record<string, ScheduledNotify>;
  fired: Record<string, number>;
  seenGiveawayIds: string[];
  seenVaultKeys: string[];
  lastGiveawayCheckAt?: number;
  hasSeededGiveaways: boolean;
  hasSeededVaultItems: boolean;
}

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const notifyRuntime: {
  lastSource?: NotificationSource;
  syncGeneration: number;
  didBindWake: boolean;
  giveawayPollId?: ReturnType<typeof setInterval>;
  shouldForceGiveawayCheck: boolean;
} = {
  syncGeneration: 0,
  didBindWake: false,
  shouldForceGiveawayCheck: false,
};

function emptyLog(): NotifyLog {
  return {
    scheduled: {},
    fired: {},
    seenGiveawayIds: [],
    seenVaultKeys: [],
    hasSeededGiveaways: false,
    hasSeededVaultItems: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const NOTIFY_KINDS: readonly NotifyKind[] = [
  "swap",
  "vault",
  "community",
  "giveaway",
];
const GIVEAWAY_CHECK_MS = 15 * 60 * 1000;
const SEEN_GIVEAWAY_KEEP = 300;

function isNotifyKind(value: unknown): value is NotifyKind {
  return (
    typeof value === "string" &&
    (NOTIFY_KINDS as readonly string[]).includes(value)
  );
}

function optionalNumberIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value.filter((id): id is number => typeof id === "number");
  return ids.length > 0 ? ids : undefined;
}

function parseScheduledNotify(value: unknown): ScheduledNotify | undefined {
  if (!isRecord(value) || !isNotifyKind(value.kind)) {
    return undefined;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.fireAt !== "number" ||
    typeof value.title !== "string" ||
    typeof value.body !== "string"
  ) {
    return undefined;
  }
  const event: ScheduledNotify = {
    id: value.id,
    kind: value.kind,
    fireAt: value.fireAt,
    title: value.title,
    body: value.body,
    url:
      typeof value.url === "string" && value.url
        ? value.url
        : notifyUrlForKind(value.kind),
  };
  const artifactIds = optionalNumberIds(value.artifactIds);
  if (artifactIds) {
    event.artifactIds = artifactIds;
  }
  if (typeof value.cycleId === "string" && value.cycleId) {
    event.cycleId = value.cycleId;
  }
  if (typeof value.targetHours === "number") {
    event.targetHours = value.targetHours;
  }
  return event;
}

function scheduledFromUnknown(value: unknown): Record<string, ScheduledNotify> {
  if (!isRecord(value)) {
    return {};
  }
  const scheduled: Record<string, ScheduledNotify> = {};
  for (const [id, item] of Object.entries(value)) {
    const event = parseScheduledNotify(item);
    if (event) {
      scheduled[id] = event;
    }
  }
  return scheduled;
}

function stringListFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function notifyLogFromUnknown(value: Record<string, unknown>): NotifyLog {
  const log: NotifyLog = {
    scheduled: scheduledFromUnknown(value.scheduled),
    fired: firedFromUnknown(value.fired),
    seenGiveawayIds: stringListFromUnknown(value.seenGiveawayIds),
    seenVaultKeys: stringListFromUnknown(value.seenVaultKeys),
    hasSeededGiveaways: value.hasSeededGiveaways === true,
    hasSeededVaultItems: value.hasSeededVaultItems === true,
  };
  if (typeof value.lastGiveawayCheckAt === "number") {
    log.lastGiveawayCheckAt = value.lastGiveawayCheckAt;
  }
  return log;
}

function firedFromUnknown(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  const fired: Record<string, number> = {};
  for (const [id, at] of Object.entries(value)) {
    if (typeof at === "number") {
      fired[id] = at;
    }
  }
  return fired;
}

async function loadNotifyLog(): Promise<NotifyLog> {
  const raw: unknown = await GM.getValue(NOTIFY_LOG_KEY);
  if (!raw) {
    return emptyLog();
  }
  try {
    const parsedUnknown: unknown =
      typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isRecord(parsedUnknown)) {
      return emptyLog();
    }
    return notifyLogFromUnknown(parsedUnknown);
  } catch (error) {
    console.error("[AWA Toolkit] Error parsing notification log:", error);
    return emptyLog();
  }
}

async function saveNotifyLog(log: NotifyLog): Promise<void> {
  await GM.setValue(NOTIFY_LOG_KEY, JSON.stringify(log));
}

function pruneFired(log: NotifyLog, now: number): void {
  for (const [id, at] of Object.entries(log.fired)) {
    if (now - at > FIRED_KEEP_MS) {
      delete log.fired[id];
    }
  }
}

function clearPendingTimers(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
}

function onNotifyClick(event: Event | undefined, url: string): void {
  event?.preventDefault();
  window.focus();
  const path = new URL(url, location.origin).pathname;
  if (location.pathname !== path) {
    location.assign(path);
  }
}

export function isNotificationPermissionGranted(): boolean {
  return (
    typeof Notification !== "undefined" && Notification.permission === "granted"
  );
}

function didShowWebNotification(options: {
  title: string;
  text: string;
  tag: string;
  url: string;
}): boolean {
  if (!isNotificationPermissionGranted()) {
    return false;
  }
  const notification = new Notification(options.title, {
    body: options.text,
    icon: NOTIFY_ICON,
    tag: options.tag,
    requireInteraction: true,
  });
  notification.addEventListener("click", () => {
    onNotifyClick(undefined, options.url);
    notification.close();
  });
  return true;
}

function didShowGmNotification(options: {
  title: string;
  text: string;
  tag: string;
  url: string;
}): boolean {
  if (typeof GM.notification !== "function") {
    return false;
  }
  try {
    GM.notification({
      title: options.title,
      text: options.text,
      image: NOTIFY_ICON,
      tag: options.tag,
      url: options.url,
      highlight: true,
      zombieTimeout: ZOMBIE_MS,
      zombieUrl: options.url,
      onclick: (event?: Event) => {
        onNotifyClick(event, options.url);
      },
    });
    return true;
  } catch (error) {
    console.error("[AWA Toolkit] GM.notification failed:", error);
    return false;
  }
}

/**
 * Prefer the site Notification API when the user already clicked Allow —
 * that is the permission the opt-in prompt grants. GM.notification is a
 * different channel (userscript manager → OS) and can stay silent.
 *
 * Do not await `GM.notification()`: Tampermonkey's promise resolves when the
 * user clicks, which would stall the scheduler.
 */
function didShowBrowserNotification(options: {
  title: string;
  text: string;
  tag: string;
  url: string;
}): boolean {
  if (didShowWebNotification(options)) {
    return true;
  }
  return didShowGmNotification(options);
}

function sortedIds(ids: Iterable<number>): number[] {
  return [...ids].toSorted((left, right) => left - right);
}

function pendingSwapTarget(
  source: NotificationSource,
):
  | { artifacts: { instanceId: number; displayName: string }[]; waitMs: number }
  | undefined {
  const { result, settings } = source;
  const best = result.best;
  const current = result.current;
  if (best && !isSameLoadout(best.artifacts, current?.artifacts)) {
    const plan = planLoadoutChanges(
      best.artifacts,
      current,
      settings,
      result.slotLocks,
    );
    if (plan.waitMs <= 0) {
      return undefined;
    }
    const later = best.artifacts.filter((artifact) =>
      plan.later.some((item) => item.artifactId === artifact.instanceId),
    );
    return {
      artifacts: later.length > 0 ? later : best.artifacts,
      waitMs: plan.waitMs,
    };
  }
  const deferred = result.deferredAllArp;
  if (!deferred || deferred.waitMs <= 0) {
    return undefined;
  }
  return { artifacts: deferred.artifacts, waitMs: deferred.waitMs };
}

function swapNotifyEvent(
  source: NotificationSource,
  now: number,
): ScheduledNotify | undefined {
  const pending = pendingSwapTarget(source);
  if (!pending) {
    return undefined;
  }
  const ids = sortedIds(
    pending.artifacts.map((artifact) => artifact.instanceId),
  );
  const event: ScheduledNotify = {
    id: `swap:${ids.join(",")}`,
    kind: "swap",
    fireAt: now + pending.waitMs,
    title: "Recommended swap ready",
    body: `You can equip ${loadoutLabel(pending.artifacts)} now.`,
    url: notifyUrlForKind("swap"),
  };
  if (ids.length > 0) {
    event.artifactIds = ids;
  }
  return event;
}

function notifyTypeKeyForKind(kind: NotifyKind): NotificationTypeKey {
  return kind === "giveaway" ? "giveaways" : kind;
}

function isKindEnabled(source: NotificationSource, kind: NotifyKind): boolean {
  return isNotificationTypeEnabled(source.settings, notifyTypeKeyForKind(kind));
}

function vaultNotifyEvent(
  source: NotificationSource,
  now: number,
): ScheduledNotify | undefined {
  const cycleId = gameVaultCycleId(source.siteState);
  const opensAt = gameVaultOpensAtMs(source.siteState);
  if (!cycleId || opensAt === undefined || opensAt <= now) {
    return undefined;
  }
  return {
    id: `vault:${cycleId}`,
    kind: "vault",
    fireAt: opensAt,
    title: "Game Vault is open",
    body: "The monthly Game Vault window is live.",
    url: notifyUrlForKind("vault"),
    cycleId,
  };
}

function communityNotifyEvent(
  source: NotificationSource,
  now: number,
): ScheduledNotify | undefined {
  const community = source.siteState.communityEvent;
  if (!community || !canEarnCommunityEventArp(community)) {
    return undefined;
  }
  const pending = breakDownCommunityEventPending(community);
  const eta = estimateNextCommunityUnlock(community, now);
  if (!eta || eta.etaMs <= 0 || pending.waitingCommunityArp <= 0) {
    return undefined;
  }
  return {
    id: `community:${eta.targetHours}`,
    kind: "community",
    fireAt: now + eta.etaMs,
    title: "Community Event unlock",
    body: `${formatCommunityEventArp(pending.waitingCommunityArp)} should unlock around now.`,
    url: community.url
      ? absoluteAwaUrl(community.url)
      : notifyUrlForKind("community"),
    targetHours: eta.targetHours,
  };
}

function collectUpcomingEvents(
  source: NotificationSource,
  now: number,
): ScheduledNotify[] {
  const events: Array<ScheduledNotify | undefined> = [];
  if (isKindEnabled(source, "swap")) {
    events.push(swapNotifyEvent(source, now));
  }
  if (isKindEnabled(source, "vault")) {
    events.push(vaultNotifyEvent(source, now));
  }
  if (isKindEnabled(source, "community")) {
    events.push(communityNotifyEvent(source, now));
  }
  return events.filter(
    (event): event is ScheduledNotify => event !== undefined,
  );
}

function vaultItemKey(game: GameVaultItem): string {
  return `${game.name}:${game.price}`;
}

function collectNewVaultItems(
  source: NotificationSource,
  log: NotifyLog,
  now: number,
): ScheduledNotify[] {
  const games = source.siteState.gameVault.filter(
    (game) => game.inStock && game.isAuction !== true,
  );
  if (games.length === 0) {
    return [];
  }
  const keys = games.map((game) => vaultItemKey(game));
  if (!log.hasSeededVaultItems) {
    log.seenVaultKeys = [...new Set([...log.seenVaultKeys, ...keys])];
    log.hasSeededVaultItems = true;
    return [];
  }
  const seen = new Set(log.seenVaultKeys);
  const events: ScheduledNotify[] = [];
  for (const game of games) {
    const key = vaultItemKey(game);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    events.push({
      id: `vault-item:${key}`,
      kind: "vault",
      fireAt: now,
      title: "New Game Vault item",
      body: game.name,
      url: notifyUrlForKind("vault"),
    });
  }
  log.seenVaultKeys = [...seen];
  return events;
}

function pruneSeenIds(ids: string[], keep: string[], max: number): string[] {
  const keepSet = new Set(keep);
  const extras = ids.filter((id) => !keepSet.has(id));
  const extraBudget = Math.max(0, max - keep.length);
  return [...keep, ...extras.slice(-extraBudget)];
}

function isGiveawayCheckDue(log: NotifyLog, now: number): boolean {
  if (notifyRuntime.shouldForceGiveawayCheck || !log.hasSeededGiveaways) {
    return true;
  }
  if (log.lastGiveawayCheckAt === undefined) {
    return true;
  }
  return now - log.lastGiveawayCheckAt >= GIVEAWAY_CHECK_MS;
}

async function collectNewGiveaways(
  log: NotifyLog,
  now: number,
): Promise<ScheduledNotify[]> {
  const shouldCheck = isGiveawayCheckDue(log, now);
  notifyRuntime.shouldForceGiveawayCheck = false;
  if (!shouldCheck) {
    return [];
  }

  const posts = await loadOfficialGiveaways();
  log.lastGiveawayCheckAt = now;
  if (posts.length === 0) {
    return [];
  }

  const postIds = posts.map((post) => post.id);
  if (!log.hasSeededGiveaways) {
    log.seenGiveawayIds = [...new Set([...log.seenGiveawayIds, ...postIds])];
    log.hasSeededGiveaways = true;
    return [];
  }

  const seen = new Set(log.seenGiveawayIds);
  const events: ScheduledNotify[] = [];
  for (const post of posts) {
    if (seen.has(post.id)) {
      continue;
    }
    seen.add(post.id);
    if (post.isClaimed === true) {
      continue;
    }
    events.push({
      id: `giveaway:${post.id}`,
      kind: "giveaway",
      fireAt: now,
      title: "New giveaway",
      body: post.title,
      url: post.url,
    });
  }
  log.seenGiveawayIds = pruneSeenIds([...seen], postIds, SEEN_GIVEAWAY_KEEP);
  return events;
}

function isSwapStillRelevant(
  event: ScheduledNotify,
  source: NotificationSource,
): boolean {
  const best = source.result.best;
  const current = source.result.current;
  if (!best || isSameLoadout(best.artifacts, current?.artifacts)) {
    return false;
  }
  if (!event.artifactIds || event.artifactIds.length === 0) {
    return true;
  }
  const bestIds = new Set(
    best.artifacts.map((artifact) => artifact.instanceId),
  );
  return event.artifactIds.some((id) => bestIds.has(id));
}

function isCommunityStillRelevant(source: NotificationSource): boolean {
  const community = source.siteState.communityEvent;
  if (!community || !canEarnCommunityEventArp(community)) {
    return false;
  }
  const pending = breakDownCommunityEventPending(community);
  return pending.waitingCommunityArp > 0 || pending.imminentArp > 0;
}

function isVaultStillRelevant(
  event: ScheduledNotify,
  source: NotificationSource,
): boolean {
  if (event.id.startsWith("vault-item:")) {
    return true;
  }
  return gameVaultOpensAtMs(source.siteState) !== undefined;
}

function isEventStillRelevant(
  event: ScheduledNotify,
  source: NotificationSource,
): boolean {
  if (!isKindEnabled(source, event.kind)) {
    return false;
  }
  if (event.kind === "swap") {
    return isSwapStillRelevant(event, source);
  }
  if (event.kind === "vault") {
    return isVaultStillRelevant(event, source);
  }
  if (event.kind === "community") {
    return isCommunityStillRelevant(source);
  }
  return true;
}

function mergeUpcomingIntoLog(
  log: NotifyLog,
  upcoming: ScheduledNotify[],
  source: NotificationSource,
  now: number,
): void {
  const upcomingIds = new Set(upcoming.map((event) => event.id));
  for (const event of upcoming) {
    log.scheduled[event.id] = event;
  }
  for (const [id, event] of Object.entries(log.scheduled)) {
    if (upcomingIds.has(id)) {
      continue;
    }
    if (isEventStillRelevant(event, source)) {
      event.fireAt = Math.min(event.fireAt, now);
      continue;
    }
    delete log.scheduled[id];
  }
}

async function didFireDueEvents(
  log: NotifyLog,
  source: NotificationSource,
  generation: number,
  now: number,
): Promise<boolean> {
  for (const [id, event] of Object.entries(log.scheduled)) {
    if (event.fireAt > now) {
      continue;
    }
    if (log.fired[id] !== undefined || !isEventStillRelevant(event, source)) {
      delete log.scheduled[id];
      continue;
    }
    if (generation !== notifyRuntime.syncGeneration) {
      return false;
    }
    const didFire = didShowBrowserNotification({
      title: event.title,
      text: event.body,
      tag: event.id,
      url: event.url,
    });
    if (didFire) {
      log.fired[id] = Date.now();
    }
    delete log.scheduled[id];
  }
  return true;
}

function armTimers(log: NotifyLog): void {
  clearPendingTimers();
  const now = Date.now();
  for (const event of Object.values(log.scheduled)) {
    const delay = Math.max(0, event.fireAt - now);
    pendingTimers.set(
      event.id,
      setTimeout(() => {
        pendingTimers.delete(event.id);
        const source = notifyRuntime.lastSource;
        if (!source) {
          return;
        }
        void syncBrowserNotifications(source);
      }, delay),
    );
  }
}

function clearGiveawayPoll(): void {
  if (notifyRuntime.giveawayPollId === undefined) {
    return;
  }
  clearInterval(notifyRuntime.giveawayPollId);
  delete notifyRuntime.giveawayPollId;
}

function armGiveawayPoll(): void {
  if (notifyRuntime.giveawayPollId !== undefined) {
    return;
  }
  notifyRuntime.giveawayPollId = setInterval(() => {
    const source = notifyRuntime.lastSource;
    if (!source?.settings.browserNotifications) {
      return;
    }
    if (!isNotificationTypeEnabled(source.settings, "giveaways")) {
      return;
    }
    void syncBrowserNotifications(source);
  }, GIVEAWAY_CHECK_MS);
}

function wakeScheduledNotifications(): void {
  const source = notifyRuntime.lastSource;
  if (!source?.settings.browserNotifications) {
    return;
  }
  void syncBrowserNotifications(source);
}

function bindWakeListeners(): void {
  if (notifyRuntime.didBindWake) {
    return;
  }
  notifyRuntime.didBindWake = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      wakeScheduledNotifications();
    }
  });
  window.addEventListener("focus", wakeScheduledNotifications);
}

function sourceWithNotificationsOn(
  source: NotificationSource,
): NotificationSource {
  return {
    ...source,
    settings: { ...source.settings, browserNotifications: true },
  };
}

async function syncBrowserNotifications(
  source: NotificationSource,
): Promise<void> {
  notifyRuntime.syncGeneration += 1;
  if (!source.settings.browserNotifications) {
    clearPendingTimers();
    clearGiveawayPoll();
    return;
  }
  const generation = notifyRuntime.syncGeneration;
  bindWakeListeners();
  armGiveawayPoll();
  const now = Date.now();
  const log = await loadNotifyLog();
  if (generation !== notifyRuntime.syncGeneration) {
    return;
  }
  const upcoming = collectUpcomingEvents(source, now);
  if (isKindEnabled(source, "vault")) {
    upcoming.push(...collectNewVaultItems(source, log, now));
  }
  if (isKindEnabled(source, "giveaway")) {
    upcoming.push(...(await collectNewGiveaways(log, now)));
  }
  if (generation !== notifyRuntime.syncGeneration) {
    return;
  }
  mergeUpcomingIntoLog(log, upcoming, source, now);
  const didFinish = await didFireDueEvents(log, source, generation, now);
  if (!didFinish) {
    return;
  }
  pruneFired(log, Date.now());
  await saveNotifyLog(log);
  if (generation !== notifyRuntime.syncGeneration) {
    return;
  }
  armTimers(log);
}

/**
 * Recompute upcoming notifications from the latest optimizer snapshot.
 * No-op when the setting is off.
 */
export function scheduleBrowserNotifications(source: NotificationSource): void {
  notifyRuntime.lastSource = source;
  void syncBrowserNotifications(source);
}

/**
 * Ask the site for the HTML5 Notification permission so the browser shows
 * its Allow / Block prompt. GM.notification uses the userscript manager and
 * never shows that prompt on its own.
 */
async function didGrantWebNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") {
    return typeof GM.notification === "function";
  }
  if (Notification.permission === "granted") {
    return true;
  }
  if (Notification.permission === "denied") {
    return false;
  }
  const permission = await Notification.requestPermission();
  return permission === "granted";
}

async function didDisableBrowserNotifications(): Promise<boolean> {
  clearPendingTimers();
  clearGiveawayPoll();
  await saveArtifactSettings({ browserNotifications: false });
  const previous = notifyRuntime.lastSource;
  if (previous) {
    notifyRuntime.lastSource = {
      ...previous,
      settings: { ...previous.settings, browserNotifications: false },
    };
  }
  return true;
}

/**
 * Turn the setting on or off. Enabling asks for permission and sends a test ping.
 */
export async function didSetBrowserNotifications(
  isEnabled: boolean,
  source?: NotificationSource,
): Promise<boolean> {
  if (!isEnabled) {
    return didDisableBrowserNotifications();
  }

  const didGrant = await didGrantWebNotificationPermission();
  if (!didGrant) {
    return false;
  }
  const didTest = didShowBrowserNotification({
    title: NOTIFY_TITLE,
    text: "Notifications are on. Use the switches below to choose recommended swap, community, Game Vault, and new giveaways.",
    tag: "awa-toolkit-test",
    url: notifyUrlForKind("community"),
  });
  if (!didTest) {
    return false;
  }

  await saveArtifactSettings({ browserNotifications: true });
  const nextSource = source ?? notifyRuntime.lastSource;
  if (nextSource) {
    notifyRuntime.lastSource = sourceWithNotificationsOn(nextSource);
    if (isNotificationTypeEnabled(nextSource.settings, "giveaways")) {
      notifyRuntime.shouldForceGiveawayCheck = true;
    }
    scheduleBrowserNotifications(notifyRuntime.lastSource);
  }
  return true;
}

export async function saveNotificationType(
  key: NotificationTypeKey,
  isEnabled: boolean,
): Promise<void> {
  const settings = await getArtifactSettings();
  const notificationTypes = {
    ...settings.notificationTypes,
    [key]: isEnabled,
  };
  await saveArtifactSettings({ notificationTypes });
  if (key === "giveaways" && isEnabled) {
    notifyRuntime.shouldForceGiveawayCheck = true;
  }
  const previous = notifyRuntime.lastSource;
  if (!previous) {
    return;
  }
  notifyRuntime.lastSource = {
    ...previous,
    settings: { ...previous.settings, notificationTypes },
  };
  scheduleBrowserNotifications(notifyRuntime.lastSource);
}
