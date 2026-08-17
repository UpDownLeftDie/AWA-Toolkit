import { GM } from '$';

import type { ArtifactTier } from './data';
import type { ActivityKey } from './siteState';

const SETTINGS_KEY = 'artifactOptimizerSettings';
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const COOLDOWN_MS =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

export type ArtifactSlotPosition = 1 | 2 | 3;

export interface ActivityToggle {
  enabled: boolean;
  /**
   * Relative weight / participation frequency multiplier (1 = full guide assumption).
   */
  frequency: number;
}

export interface ManualOwnedArtifact {
  familyId: string;
  tier: ArtifactTier;
  instanceId?: number;
  equippedPosition?: ArtifactSlotPosition;
}

export interface SlotCooldownEntry {
  position: ArtifactSlotPosition;
  changedAt: string;
  artifactInstanceId?: number;
  /**
  Invented from a Showroom lock icon when no API equip timestamp was known.
  Never refresh `changedAt` from later scrapes — only `recordSlotChange` may.
  */
  estimated?: boolean;
}

export interface ArtifactOptimizerSettings {
  activities: Record<ActivityKey, ActivityToggle>;
  /**
   * Target list-price Game Vault claim (ARP); 0 = first claimable vault price. Not auction bids.
   */
  pendingVaultPurchaseArp: number;
  /**
   * Manual fragment override; undefined = use scraped.
   */
  manualFragments?: number;
  /**
   * Manual owned list; empty = use scraped only.
   */
  manualArtifacts: ManualOwnedArtifact[];
  /**
   * Prefer scraped data when both exist.
   */
  preferScraped: boolean;
  slotCooldowns: SlotCooldownEntry[];
  /**
  Skip Game Vault discount recs for this rotation (`gameVaultCycleId`).
  */
  vaultDiscountDismissedCycle?: string;
  /**
  Twitch logins to open first when picking a Watch Twitch stream (list order).
  */
  preferredTwitchStreamers: string[];
  /**
  OS desktop notifications via GM.notification for known times (recommended
  swap, vault open). An AWA tab must stay open to schedule them.
  */
  browserNotifications: boolean;
  /**
  Which events fire while `browserNotifications` is on. Missing keys default on.
  */
  notificationTypes: NotificationTypeToggles;
  /**
  Equip / upgrade / claim Battle Pass via AWA APIs. Off by default (use at
  your own risk). Missing saved values stay off so 2.0 installs opt in.
  */
  allowAccountActions: boolean;
}

export const NOTIFICATION_TYPE_KEYS = [
  'swap',
  'community',
  'vault',
  'giveaways',
] as const;

export type NotificationTypeKey = (typeof NOTIFICATION_TYPE_KEYS)[number];

export type NotificationTypeToggles = Record<NotificationTypeKey, boolean>;

export const NOTIFICATION_TYPE_COPY: Record<
  NotificationTypeKey,
  { title: string; hint: string }
> = {
  swap: {
    title: 'Recommended swap',
    hint: 'When a better loadout is waiting on a 24h lock — not every unlock.',
  },
  community: {
    title: 'Community Event',
    hint: 'When community hours unlock pending ARP.',
  },
  vault: {
    title: 'Game Vault',
    hint: 'When the vault opens or new games appear.',
  },
  giveaways: {
    title: 'New giveaways',
    hint: 'Official Alienware key giveaways — not community giveaways.',
  },
};

const DEFAULT_NOTIFICATION_TYPES: NotificationTypeToggles = {
  swap: true,
  community: true,
  vault: true,
  giveaways: true,
};

const DEFAULT_ACTIVITIES: Record<ActivityKey, ActivityToggle> = {
  timeOnSite: { enabled: true, frequency: 1 },
  steamQuests: { enabled: true, frequency: 1 },
  watchTwitch: { enabled: true, frequency: 1 },
  dailyCalendar: { enabled: true, frequency: 1 },
  discordPoll: { enabled: true, frequency: 1 },
  dailyQuests: { enabled: true, frequency: 1 },
  steamCommunityEvent: { enabled: true, frequency: 1 },
};

export const defaultArtifactSettings: ArtifactOptimizerSettings = {
  activities: { ...DEFAULT_ACTIVITIES },
  pendingVaultPurchaseArp: 0,
  manualArtifacts: [],
  preferScraped: true,
  slotCooldowns: [],
  preferredTwitchStreamers: [],
  browserNotifications: false,
  notificationTypes: { ...DEFAULT_NOTIFICATION_TYPES },
  allowAccountActions: false,
};

function isPartialSettings(
  value: unknown,
): value is Partial<ArtifactOptimizerSettings> {
  return typeof value === 'object' && !!value;
}

function mergeActivities(
  base: Record<ActivityKey, ActivityToggle>,
  incoming: Partial<Record<ActivityKey, ActivityToggle>> | undefined,
): Record<ActivityKey, ActivityToggle> {
  if (!incoming) {
    return base;
  }
  const legacy = incoming as Partial<Record<ActivityKey, ActivityToggle>> & {
    communityEvent?: ActivityToggle;
  };
  const next = { ...base };
  // Older builds used `communityEvent` for Control Center daily/weekend quests.
  if (legacy.communityEvent && !legacy.dailyQuests) {
    next.dailyQuests = {
      enabled: legacy.communityEvent.enabled,
      frequency:
        typeof legacy.communityEvent.frequency === 'number'
          ? legacy.communityEvent.frequency
          : 1,
    };
  }
  for (const key of Object.keys(DEFAULT_ACTIVITIES) as ActivityKey[]) {
    const value = incoming[key];
    if (!value) {
      continue;
    }
    next[key] = {
      enabled: value.enabled,
      frequency: typeof value.frequency === 'number' ? value.frequency : 1,
    };
  }
  return next;
}

function applyParsedSettings(
  settings: ArtifactOptimizerSettings,
  parsed: Partial<ArtifactOptimizerSettings>,
): void {
  settings.activities = mergeActivities(settings.activities, parsed.activities);

  if (typeof parsed.pendingVaultPurchaseArp === 'number') {
    settings.pendingVaultPurchaseArp = parsed.pendingVaultPurchaseArp;
  }
  if (typeof parsed.manualFragments === 'number') {
    settings.manualFragments = parsed.manualFragments;
  }
  if (Array.isArray(parsed.manualArtifacts)) {
    settings.manualArtifacts = parsed.manualArtifacts;
  }
  if (typeof parsed.preferScraped === 'boolean') {
    settings.preferScraped = parsed.preferScraped;
  }
  if (Array.isArray(parsed.slotCooldowns)) {
    settings.slotCooldowns = parsed.slotCooldowns;
  }
  if (typeof parsed.vaultDiscountDismissedCycle === 'string') {
    if (parsed.vaultDiscountDismissedCycle) {
      settings.vaultDiscountDismissedCycle = parsed.vaultDiscountDismissedCycle;
    } else {
      delete settings.vaultDiscountDismissedCycle;
    }
  }
  if (Array.isArray(parsed.preferredTwitchStreamers)) {
    const rawLogins = parsed.preferredTwitchStreamers.filter(
      (item): item is string => typeof item === 'string',
    );
    settings.preferredTwitchStreamers =
      parsePreferredTwitchStreamers(rawLogins.join('\n'));
  }
  if (typeof parsed.browserNotifications === 'boolean') {
    settings.browserNotifications = parsed.browserNotifications;
  }
  if (typeof parsed.allowAccountActions === 'boolean') {
    settings.allowAccountActions = parsed.allowAccountActions;
  }
  settings.notificationTypes = mergeNotificationTypes(
    settings.notificationTypes,
    parsed.notificationTypes,
  );
}

function mergeNotificationTypes(
  base: NotificationTypeToggles,
  incoming: Partial<NotificationTypeToggles> | undefined,
): NotificationTypeToggles {
  if (!incoming) {
    return base;
  }
  const next = { ...base };
  for (const key of NOTIFICATION_TYPE_KEYS) {
    if (typeof incoming[key] === 'boolean') {
      next[key] = incoming[key];
    }
  }
  return next;
}

/**
 * Normalize a typed Twitch login / URL to a lowercase channel login.
 */
export function twitchLoginFromInput(value: string): string {
  let text = value.trim();
  if (!text) {
    return '';
  }
  text = text.replace(/^https?:\/\//i, '');
  text = text.replace(/^(www\.)?twitch\.tv\//i, '');
  text = text.replace(/^@/, '');
  const login = text.split(/[/?#]/, 1)[0] ?? '';
  return login.trim().toLowerCase();
}

/**
 * One login per line (commas also split). Duplicates are dropped, order kept.
 */
export function parsePreferredTwitchStreamers(raw: string): string[] {
  const logins: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\n,]+/)) {
    const login = twitchLoginFromInput(token);
    if (!login || seen.has(login)) {
      continue;
    }
    seen.add(login);
    logins.push(login);
  }
  return logins;
}

export async function getArtifactSettings(): Promise<ArtifactOptimizerSettings> {
  const raw: string | Partial<ArtifactOptimizerSettings> | undefined =
    await GM.getValue(SETTINGS_KEY);
  const settings: ArtifactOptimizerSettings = {
    ...defaultArtifactSettings,
    activities: { ...DEFAULT_ACTIVITIES },
    manualArtifacts: [],
    slotCooldowns: [],
    preferredTwitchStreamers: [],
    notificationTypes: { ...DEFAULT_NOTIFICATION_TYPES },
  };

  if (!raw) {
    return settings;
  }

  try {
    const parsedUnknown: unknown =
      typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isPartialSettings(parsedUnknown)) {
      return settings;
    }
    applyParsedSettings(settings, parsedUnknown);
  } catch (error) {
    console.error('[Artifact Optimizer] Error parsing settings:', error);
  }

  return settings;
}

export async function saveArtifactSettings(
  patch: Partial<ArtifactOptimizerSettings>,
): Promise<ArtifactOptimizerSettings> {
  const previous = await getArtifactSettings();
  const next: ArtifactOptimizerSettings = {
    ...previous,
    ...patch,
    activities: patch.activities
      ? { ...previous.activities, ...patch.activities }
      : previous.activities,
    notificationTypes: patch.notificationTypes
      ? { ...previous.notificationTypes, ...patch.notificationTypes }
      : previous.notificationTypes,
  };
  await GM.setValue(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

function findCooldownEntry(
  settings: ArtifactOptimizerSettings,
  position: ArtifactSlotPosition,
): SlotCooldownEntry | undefined {
  return settings.slotCooldowns.find((entry) => entry.position === position);
}

export function isSlotOnCooldown(
  settings: ArtifactOptimizerSettings,
  position: ArtifactSlotPosition,
  now = Date.now(),
): boolean {
  return cooldownRemainingMs(settings, position, now) > 0;
}

/**
 * Showroom lock icons are the source of truth for whether a slot is locked —
 * same role the ARP Log has for Discord Poll / calendar completion.
 * GM `slotCooldowns` never invent a lock; they only answer "how long left?"
 * after the showroom says locked.
 */
export function isShowroomSlotLocked(
  position: ArtifactSlotPosition,
  options: {
    slotLocks?: Partial<Record<ArtifactSlotPosition, boolean>>;
    equippedSlotLocked?: boolean;
  } = {},
): boolean {
  if (options.equippedSlotLocked === true) {
    return true;
  }
  if (options.equippedSlotLocked === false) {
    return false;
  }
  return options.slotLocks?.[position] === true;
}

/**
 * Remaining cooldown ms for UI / wait math. Always 0 when the showroom says
 * the slot is unlocked — even if a stale GM timer still exists.
 */
export function showroomCooldownRemainingMs(
  settings: ArtifactOptimizerSettings,
  position: ArtifactSlotPosition,
  options: {
    slotLocks?: Partial<Record<ArtifactSlotPosition, boolean>>;
    equippedSlotLocked?: boolean;
    now?: number;
  } = {},
): number {
  if (!isShowroomSlotLocked(position, options)) {
    return 0;
  }
  return cooldownRemainingMs(settings, position, options.now);
}

export function cooldownRemainingMs(
  settings: ArtifactOptimizerSettings,
  position: ArtifactSlotPosition,
  now = Date.now(),
): number {
  const entry = findCooldownEntry(settings, position);
  if (!entry) {
    return 0;
  }
  const changedAt = Date.parse(entry.changedAt);
  if (Number.isNaN(changedAt)) {
    return 0;
  }
  return Math.max(0, COOLDOWN_MS - (now - changedAt));
}

export async function recordSlotChange(
  position: ArtifactSlotPosition,
  artifactInstanceId?: number,
): Promise<void> {
  const settings = await getArtifactSettings();
  const rest = settings.slotCooldowns.filter(
    (entry) => entry.position !== position,
  );
  const entry: SlotCooldownEntry = {
    position,
    changedAt: new Date().toISOString(),
  };
  if (artifactInstanceId !== undefined) {
    entry.artifactInstanceId = artifactInstanceId;
  }
  rest.push(entry);
  await saveArtifactSettings({ slotCooldowns: rest });
}

const SLOT_POSITIONS: ArtifactSlotPosition[] = [1, 2, 3];

function isCompleteSlotLockMap(
  slotLocks: Partial<Record<ArtifactSlotPosition, boolean>>,
): slotLocks is Record<ArtifactSlotPosition, boolean> {
  return SLOT_POSITIONS.every(
    (position) => typeof slotLocks[position] === 'boolean',
  );
}

/**
 * Align GM remaining-time timers with Showroom lock icons.
 *
 * Showroom is source of truth for locked vs open (like ARP Log for caps).
 * Local `changedAt` only stores duration for slots the showroom still locks:
 * - Unlocked → drop any local timer
 * - Locked + existing timer → keep measured/estimated clock
 * - Locked + no timer → one-time estimated 24h from now
 */
export async function syncSlotLocksFromScrape(
  slotLocks: Partial<Record<ArtifactSlotPosition, boolean>>,
  now = Date.now(),
): Promise<void> {
  const settings = await getArtifactSettings();
  const previous = settings.slotCooldowns;
  const next: SlotCooldownEntry[] = [];

  for (const position of SLOT_POSITIONS) {
    if (slotLocks[position] !== true) {
      continue;
    }
    const existing = previous.find((entry) => entry.position === position);
    if (existing) {
      next.push(existing);
      continue;
    }
    next.push({
      position,
      changedAt: new Date(now).toISOString(),
      estimated: true,
    });
  }

  // Incomplete scrapes (missing keys) must not wipe timers for omitted slots.
  if (!isCompleteSlotLockMap(slotLocks)) {
    for (const entry of previous) {
      if (
        slotLocks[entry.position] !== false &&
        next.every((row) => row.position === entry.position)
      ) {
        next.push(entry);
      }
    }
  }

  const previousKey = JSON.stringify(previous);
  const nextKey = JSON.stringify(next);
  if (previousKey !== nextKey) {
    await saveArtifactSettings({ slotCooldowns: next });
  }
}

export function isNotificationTypeEnabled(
  settings: ArtifactOptimizerSettings,
  key: NotificationTypeKey,
): boolean {
  return settings.notificationTypes[key] ?? true;
}

export function areAccountActionsEnabled(
  settings: ArtifactOptimizerSettings,
): boolean {
  return settings.allowAccountActions;
}

export { COOLDOWN_MS };
