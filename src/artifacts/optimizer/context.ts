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
): OptimizerContext {
  return {
    snapshot,
    settings,
    siteState: siteState ?? emptySiteState(),
  };
}
