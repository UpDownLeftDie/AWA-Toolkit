import {
  ARTIFACT_SETS,
  ArtifactTier,
  displayNameFor,
  fragmentCostToUpgradeFrom,
  getArtifactById,
} from '../data';
import { type ArtifactSnapshot, type OwnedArtifact } from '../scraper';
import {
  COOLDOWN_MS,
  DEFAULT_UTC_DAILY_END_BUFFER_HOURS,
  isShowroomSlotLocked,
  showroomCooldownRemainingMs,
  type ArtifactOptimizerSettings,
} from '../settings';
import {
  breakDownCommunityEventPending,
  canEarnCommunityEventArp,
  emptySiteState,
  estimateNextCommunityUnlock,
  type SiteState,
} from '../siteState';
import type { OptimizerContext } from './types';

export function resolveNow(context: Pick<OptimizerContext, 'nowMs'>): number {
  return context.nowMs ?? Date.now();
}

export function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) {
    return [[]];
  }
  if (items.length < k) {
    return [];
  }
  const [first, ...rest] = items;
  if (first === undefined) {
    return [];
  }
  const withFirst = combinations(rest, k - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

export function msUntilNextUtcMidnight(now = Date.now()): number {
  const date = new Date(now);
  return Math.max(
    0,
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) -
      now,
  );
}

/**
 * Steam Quest week rolls at Monday 00:00 UTC.
 */
export function msUntilNextSteamQuestWeek(now = Date.now()): number {
  const date = new Date(now);
  const day = date.getUTCDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  return Math.max(
    0,
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + daysUntilMonday,
    ) - now,
  );
}

/**
 * True when a reset at `delayMs` from now still lands while this loadout is
 * worn (`waitMs` until equip, then `horizonMs` lock — default 24h).
 */
export function isResetInWearWindow(
  delayMs: number,
  waitMs = 0,
  horizonMs = COOLDOWN_MS,
): boolean {
  return delayMs > waitMs && delayMs <= waitMs + horizonMs;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Default practical end of a UTC daily sit (`utcDailyEndBufferHours` = 1 →
 * about 23:00 UTC). Override per user via Artifact Optimizer settings.
 */
export const UTC_DAILY_END_BUFFER_MS =
  DEFAULT_UTC_DAILY_END_BUFFER_HOURS * MS_PER_HOUR;

/**
 * Overlap between an activity's availability window and this loadout's wear
 * window (`waitMs` until equip, then `horizonMs` lock).
 */
export function wearWindowOverlapMs(
  availableFromMs: number,
  availableUntilMs: number,
  waitMs = 0,
  horizonMs = COOLDOWN_MS,
): number {
  return Math.max(
    0,
    Math.min(availableUntilMs, waitMs + horizonMs) -
      Math.max(availableFromMs, waitMs),
  );
}

/**
 * True when `durationMs` still fits in the overlap of availability and wear.
 * Instant claims (`durationMs === 0`) need a real overlap — zero overlap is
 * not "completable" or every future weekly would count in every 24h lock.
 */
export function canCompleteInWearWindow(
  availableFromMs: number,
  availableUntilMs: number,
  waitMs: number,
  durationMs: number,
  horizonMs = COOLDOWN_MS,
): boolean {
  const overlap = wearWindowOverlapMs(
    availableFromMs,
    availableUntilMs,
    waitMs,
    horizonMs,
  );
  if (durationMs <= 0) {
    return overlap > 0;
  }
  return overlap >= durationMs;
}

/**
 * True when `durationMs` still fits in the UTC day *outside* this loadout's
 * wear window — before `waitMs` or after the 24h lock — with the user's
 * cutoff (default 23:00 UTC). A delayed All-ARP% lock is not charged for
 * Twitch the player can still finish on a flat set.
 *
 * `waitMs === 0` still counts as "before": finish this sit, then equip.
 */
export function canCompleteOutsideWearWindow(
  availableFromMs: number,
  availableUntilMs: number,
  waitMs: number,
  durationMs: number,
  horizonMs = COOLDOWN_MS,
  deadlineBufferMs = UTC_DAILY_END_BUFFER_MS,
): boolean {
  const deadline = availableUntilMs - deadlineBufferMs;
  const lockStartMs =
    waitMs === 0 && availableFromMs <= 0
      ? availableFromMs + durationMs
      : waitMs;
  const beforeMs = Math.min(deadline, lockStartMs) - availableFromMs;
  if (beforeMs >= durationMs) {
    return true;
  }
  const afterMs = deadline - Math.max(availableFromMs, waitMs + horizonMs);
  return afterMs >= durationMs;
}

/**
 * UTC-day start offsets (ms from now) whose dailies can still be finished
 * while this loadout is worn. `0` is today when `todayAvailable`.
 *
 * A 24h lock that starts after today's reset still covers tonight's leftover
 * plus tomorrow after 00:00 UTC — both count toward lifetime ARP.
 */
export function completableUtcDayStarts(
  waitMs: number,
  durationMs: number,
  options: {
    todayAvailable: boolean;
    horizonMs?: number;
    now?: number;
  },
): number[] {
  const now = options.now ?? Date.now();
  const midnight = msUntilNextUtcMidnight(now);
  const horizonMs = options.horizonMs ?? COOLDOWN_MS;
  const starts: number[] = [];
  if (
    options.todayAvailable &&
    canCompleteInWearWindow(0, midnight, waitMs, durationMs, horizonMs)
  ) {
    starts.push(0);
  }
  for (let day = 0; day < 3; day += 1) {
    const dayStart = midnight + day * MS_PER_DAY;
    if (dayStart >= waitMs + horizonMs) {
      break;
    }
    const dayEnd = dayStart + MS_PER_DAY;
    if (
      canCompleteInWearWindow(dayStart, dayEnd, waitMs, durationMs, horizonMs)
    ) {
      starts.push(dayStart);
    }
  }
  return starts;
}

/**
 * True when a weekly activity that ends at `weekendMs` cannot be finished
 * after this loadout's lock — it must be done while worn, or it is lost.
 */
export function isWeeklyForcedIntoLock(
  weekendMs: number,
  waitMs: number,
  horizonMs = COOLDOWN_MS,
): boolean {
  return waitMs + horizonMs >= weekendMs;
}

/**
 * ms until this combo can go on (0 when it is already the equipped set).
 */
export function comboEquipWaitMs(
  combo: OwnedArtifact[],
  owned: OwnedArtifact[],
  settings: ArtifactOptimizerSettings,
  slotLocks?: Partial<Record<1 | 2 | 3, boolean>>,
  now = Date.now(),
): number {
  if (isSameLoadout(combo, currentLoadout(owned))) {
    return 0;
  }
  const comboIds = new Set(combo.map((artifact) => artifact.instanceId));
  let waitMs = 0;
  for (const position of [1, 2, 3] as const) {
    const equipped = owned.find(
      (artifact) => artifact.equippedPosition === position,
    );
    if (equipped && comboIds.has(equipped.instanceId)) {
      continue;
    }
    waitMs = Math.max(
      waitMs,
      showroomCooldownRemainingMs(settings, position, {
        ...(slotLocks && { slotLocks }),
        ...(typeof equipped?.slotLocked === 'boolean' && {
          equippedSlotLocked: equipped.slotLocked,
        }),
        now,
      }),
    );
  }
  return waitMs;
}

/**
 * Soonest All-ARP% deadline in this 24h window (UTC reset, and community
 * unlock when ASCE ETA is inside the lock). Slots that unlock before this
 * can still complete Zorathian / HPC; slots locked past it cannot.
 */
export function pinHorizonMs(siteState: SiteState, now = Date.now()): number {
  const untilReset = msUntilNextUtcMidnight(now);
  const event = siteState.communityEvent;
  if (!event?.isLive || !canEarnCommunityEventArp(event)) {
    return untilReset;
  }
  const pending = breakDownCommunityEventPending(event);
  if (pending.waitingCommunityArp <= 0) {
    return untilReset;
  }
  const eta = estimateNextCommunityUnlock(event, now);
  if (eta === undefined || eta.etaMs > COOLDOWN_MS) {
    return untilReset;
  }
  return Math.min(untilReset, eta.etaMs);
}

export function pinnedEquippedArtifacts(
  owned: OwnedArtifact[],
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  slotLocks?: Partial<Record<1 | 2 | 3, boolean>>,
): OwnedArtifact[] {
  const horizonMs = pinHorizonMs(siteState);
  return owned.filter((artifact) => {
    if (artifact.equippedPosition === undefined) {
      return false;
    }
    // Showroom only — never pin from a GM timer alone.
    if (
      !isShowroomSlotLocked(artifact.equippedPosition, {
        ...(slotLocks && { slotLocks }),
        ...(typeof artifact.slotLocked === 'boolean' && {
          equippedSlotLocked: artifact.slotLocked,
        }),
      })
    ) {
      return false;
    }
    const remaining = showroomCooldownRemainingMs(
      settings,
      artifact.equippedPosition,
      {
        ...(slotLocks && { slotLocks }),
        ...(typeof artifact.slotLocked === 'boolean' && {
          equippedSlotLocked: artifact.slotLocked,
        }),
      },
    );
    if (remaining > 0) {
      return remaining >= horizonMs;
    }
    // Locked on showroom, duration unknown — keep pinned.
    return true;
  });
}

export function combinationsWithPinned(
  owned: OwnedArtifact[],
  size: number,
  pinned: OwnedArtifact[],
): OwnedArtifact[][] {
  if (pinned.length >= size) {
    return [pinned.slice(0, size)];
  }
  const pinnedIds = new Set(pinned.map((artifact) => artifact.instanceId));
  const rest = owned.filter((artifact) => !pinnedIds.has(artifact.instanceId));
  return combinations(rest, size - pinned.length).map((extra) => [
    ...pinned,
    ...extra,
  ]);
}

export function activeSets(familyIds: string[]): typeof ARTIFACT_SETS {
  return ARTIFACT_SETS.filter(
    (set) =>
      !set.unconfirmed && set.memberIds.every((id) => familyIds.includes(id)),
  );
}

export function resolveOwnedList(context: OptimizerContext): OwnedArtifact[] {
  const { snapshot, settings } = context;
  if (settings.preferScraped && snapshot.artifacts.length > 0) {
    return snapshot.artifacts;
  }
  if (settings.manualArtifacts.length > 0) {
    return settings.manualArtifacts.map((manual, index) => {
      const family = getArtifactById(manual.familyId);
      const owned: OwnedArtifact = {
        instanceId: manual.instanceId ?? -(index + 1),
        familyId: manual.familyId,
        displayName: family
          ? displayNameFor(family, manual.tier)
          : manual.familyId,
        tier: manual.tier,
        category: family?.category ?? 'Weapon',
        maxLevel: manual.tier >= ArtifactTier.Interstellar,
        perkDescription: '',
      };
      const upgradeCost = fragmentCostToUpgradeFrom(manual.tier);
      if (upgradeCost !== undefined) {
        owned.upgradeCost = upgradeCost;
      }
      if (manual.equippedPosition !== undefined) {
        owned.equippedPosition = manual.equippedPosition;
      }
      return owned;
    });
  }
  return snapshot.artifacts;
}

export function currentLoadout(owned: OwnedArtifact[]): OwnedArtifact[] {
  return owned
    .filter((artifact) => artifact.equippedPosition !== undefined)
    .toSorted(
      (left, right) =>
        (left.equippedPosition ?? 0) - (right.equippedPosition ?? 0),
    );
}

export function isSameLoadout(
  left: OwnedArtifact[],
  right: OwnedArtifact[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightIds = new Set(right.map((artifact) => artifact.instanceId));
  return left.every((artifact) => rightIds.has(artifact.instanceId));
}

export function buildContext(
  snapshot: ArtifactSnapshot,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState | undefined,
  nowMs?: number,
): OptimizerContext {
  const context: OptimizerContext = {
    snapshot,
    settings,
    siteState: siteState ?? emptySiteState(),
  };
  if (nowMs !== undefined) {
    context.nowMs = nowMs;
  }
  return context;
}
