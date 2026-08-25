import {
  ArtifactEffectType,
  MONTHLY_ARP_FOR_PCT,
  MONTHLY_CATEGORY_USES,
} from '../data';
import type { OptimizerResult, ScoredCombo } from '../optimizer';
import { collectBonuses } from '../optimizer/bonuses';
import { activeSets, combinations } from '../optimizer/context';
import {
  isShowroomSlotLocked,
  showroomCooldownRemainingMs,
  type ArtifactOptimizerSettings,
} from '../settings';

export function formatMs(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0 && mins > 0) {
    return `${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (mins > 0) {
    return `${mins}m`;
  }
  return '<1m';
}

/**
Daily AWA activities (calendar, Twitch, etc.) reset at 00:00 UTC.
*/
export function msUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(0, next - now.getTime());
}

export function utcResetDeadlineLabel(now = new Date()): string {
  return `${formatMs(msUntilUtcMidnight(now))} left`;
}

/**
 * Worn loadouts and planned display copies (every piece has a slot) stay in
 * slot 1–3 order. Other lists stay alphabetical.
 */
export function sortArtifactsForDisplay<
  T extends { displayName: string; equippedPosition?: number },
>(artifacts: T[]): T[] {
  const isWornLoadout = artifacts.every(
    (artifact) => artifact.equippedPosition !== undefined,
  );
  if (isWornLoadout) {
    return artifacts.toSorted(
      (left, right) =>
        (left.equippedPosition ?? 0) - (right.equippedPosition ?? 0),
    );
  }
  return artifacts.toSorted((left, right) =>
    left.displayName.localeCompare(right.displayName, undefined, {
      sensitivity: 'base',
    }),
  );
}

export type ArtifactSlot = 1 | 2 | 3;

interface LoadoutLabelContext {
  current?: ScoredCombo;
  settings: ArtifactOptimizerSettings;
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>;
}

export function artifactsForDisplay(
  combo: Pick<ScoredCombo, 'artifacts' | 'displayArtifacts'>,
): ScoredCombo['artifacts'] {
  return combo.displayArtifacts ?? sortArtifactsForDisplay(combo.artifacts);
}

export function loadoutLabel(
  artifacts: { displayName: string; equippedPosition?: number }[] | undefined,
): string {
  if (!artifacts || artifacts.length === 0) {
    return '—';
  }
  return sortArtifactsForDisplay(artifacts)
    .map((artifact) => artifact.displayName)
    .join(' + ');
}

export function comboLabel(result: OptimizerResult['best']): string {
  if (!result) {
    return '—';
  }
  return loadoutLabel(artifactsForDisplay(result));
}

export function loadoutSetNames(
  artifacts: { familyId: string }[] | undefined,
): string[] {
  if (!artifacts || artifacts.length === 0) {
    return [];
  }
  return activeSets(artifacts.map((artifact) => artifact.familyId)).map(
    (set) => set.name,
  );
}

export function isSameLoadout(
  left: { instanceId: number }[] | undefined,
  right: { instanceId: number }[] | undefined,
): boolean {
  if (!left || !right || left.length === 0 || right.length === 0) {
    return false;
  }
  const leftIds = new Set(left.map((artifact) => artifact.instanceId));
  const rightIds = new Set(right.map((artifact) => artifact.instanceId));
  return (
    leftIds.size === rightIds.size &&
    [...leftIds].every((id) => rightIds.has(id))
  );
}

export function maxSlotCooldownMs(
  settings: ArtifactOptimizerSettings,
  current?: ScoredCombo,
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>,
): number {
  return Math.max(
    0,
    ...([1, 2, 3] as const).map((position) => {
      const equippedSlotLocked = current?.artifacts.find(
        (artifact) => artifact.equippedPosition === position,
      )?.slotLocked;
      return showroomCooldownRemainingMs(settings, position, {
        ...(slotLocks && { slotLocks }),
        ...(typeof equippedSlotLocked === 'boolean' && { equippedSlotLocked }),
      });
    }),
  );
}

/**
 * Per-slot cooldown labels (same shape as the panel note). Prefer this over a
 * single max/min — slots unlock independently.
 */
export function formatLockedSlotParts(
  settings: ArtifactOptimizerSettings,
  lockedSlots: ArtifactSlot[],
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>,
): string[] {
  return lockedSlots.map((position) => {
    const remaining = showroomCooldownRemainingMs(settings, position, {
      ...(slotLocks && { slotLocks }),
    });
    const entry = settings.slotCooldowns.find(
      (slot) => slot.position === position,
    );
    const estimateTag = entry?.estimated === true ? ', estimated' : '';
    if (remaining <= 0) {
      return `slot ${position} (locked${estimateTag})`;
    }
    return `slot ${position} (${formatMs(remaining)} left${estimateTag})`;
  });
}

export function hasAnySlotOnCooldown(
  current?: ScoredCombo,
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>,
): boolean {
  return ([1, 2, 3] as const).some((position) =>
    isSlotLockedForEquip(current, position, slotLocks),
  );
}

/**
 * Showroom lock icons decide lock state. GM timers are not consulted.
 */
export function isSlotLockedForEquip(
  current: ScoredCombo | undefined,
  position: ArtifactSlot,
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>,
): boolean {
  const equipped = current?.artifacts.find(
    (artifact) => artifact.equippedPosition === position,
  );
  return isShowroomSlotLocked(position, {
    ...(slotLocks && { slotLocks }),
    ...(typeof equipped?.slotLocked === 'boolean' && {
      equippedSlotLocked: equipped.slotLocked,
    }),
  });
}

export interface LoadoutChangePlan {
  now: {
    artifactId: number;
    position: ArtifactSlot;
    displayName: string;
    replacedDisplayName?: string;
  }[];
  later: {
    artifactId: number;
    position: ArtifactSlot;
    displayName: string;
    replacedDisplayName?: string;
  }[];
  laterNames: string[];
  lockedSlots: ArtifactSlot[];
  waitMs: number;
}

export function plannedEquipLabel(change: {
  displayName: string;
  position: ArtifactSlot;
}): string {
  return `${change.displayName} → slot ${change.position}`;
}

/**
 * Monthly ARP proxy for a loadout — same weights as upgrade / search scoring.
 * Used to decide which partial fill maximizes lifetime ARP for the next lock.
 */
function loadoutMonthlyScore(artifacts: ScoredCombo['artifacts']): number {
  const bonuses = collectBonuses(artifacts);
  return (
    bonuses.allArpPct * MONTHLY_ARP_FOR_PCT +
    bonuses.steamQuests *
      (MONTHLY_CATEGORY_USES[ArtifactEffectType.SteamQuests] ?? 0) +
    bonuses.watchTwitch *
      (MONTHLY_CATEGORY_USES[ArtifactEffectType.WatchTwitch] ?? 0) +
    bonuses.dailyCalendar *
      (MONTHLY_CATEGORY_USES[ArtifactEffectType.DailyCalendar] ?? 0) +
    bonuses.timeOnSite *
      (MONTHLY_CATEGORY_USES[ArtifactEffectType.TimeOnSite] ?? 0) +
    bonuses.discordPoll *
      (MONTHLY_CATEGORY_USES[ArtifactEffectType.DiscordPoll] ?? 0) +
    // Rough vault-price stand-in so discount pieces still rank above cosmetics.
    bonuses.marketDiscountPct * 1000 +
    bonuses.communityPlaytimePct * 200
  );
}

/**
 * Marginal monthly value of adding `artifact` onto an already-chosen basis.
 */
function marginalEquipScore(
  artifact: ScoredCombo['artifacts'][number],
  basis: ScoredCombo['artifacts'],
): number {
  return loadoutMonthlyScore([...basis, artifact]) - loadoutMonthlyScore(basis);
}

function compareByName(
  left: ScoredCombo['artifacts'][number],
  right: ScoredCombo['artifacts'][number],
): number {
  return left.displayName.localeCompare(right.displayName, undefined, {
    sensitivity: 'base',
  });
}

/**
 * Order pieces by marginal value onto `basis` (highest first). Used so that if
 * only some API equips succeed, the best activator lands before weaker ones.
 */
function sortByMarginalEquipPriority(
  pieces: ScoredCombo['artifacts'],
  basis: ScoredCombo['artifacts'],
): ScoredCombo['artifacts'] {
  return pieces.toSorted((left, right) => {
    const scoreDelta =
      marginalEquipScore(right, basis) - marginalEquipScore(left, basis);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return compareByName(left, right);
  });
}

/**
 * Choose which of the recommended missing pieces to put in the free slots.
 *
 * Leave-one-out on the *full* combo overvalues orphan set members (each
 * Zorathian piece looks like +10% All-ARP even when one slot cannot finish the
 * set). Instead pick the subset of size `slotCount` that maximizes monthly ARP
 * together with pieces already kept, then order that subset by marginal gain
 * so mid-failure still prefers All-ARP activators / high flats.
 */
function pickImmediateEquips(
  kept: ScoredCombo['artifacts'],
  remaining: ScoredCombo['artifacts'],
  slotCount: number,
): ScoredCombo['artifacts'] {
  const fillCount = Math.min(slotCount, remaining.length);
  if (fillCount <= 0) {
    return [];
  }

  let bestSubset: ScoredCombo['artifacts'] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const subset of combinations(remaining, fillCount)) {
    const score = loadoutMonthlyScore([...kept, ...subset]);
    if (score < bestScore) {
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSubset = subset;
      continue;
    }
    // Stable tie-break for equal ARP.
    const bestKey = bestSubset.map((item) => item.displayName).join('|');
    const nextKey = subset.map((item) => item.displayName).join('|');
    if (nextKey.localeCompare(bestKey) < 0) {
      bestSubset = subset;
    }
  }

  const ordered: ScoredCombo['artifacts'] = [];
  const pool = [...bestSubset];
  const basis = [...kept];
  while (pool.length > 0) {
    pool.sort((left, right) => {
      const scoreDelta =
        marginalEquipScore(right, basis) - marginalEquipScore(left, basis);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return compareByName(left, right);
    });
    const next = pool.shift();
    if (!next) {
      break;
    }
    ordered.push(next);
    basis.push(next);
  }
  return ordered;
}

/**
 * Keep combo pieces already in place (including locked slots we cannot touch).
 * Fill remaining recommended pieces into unlocked slots only so their 24h
 * cooldown starts now instead of waiting for every slot to unlock.
 *
 * Free-slot fills pick the ARP-max subset (All-ARP% / completed sets when they
 * fit, otherwise best category flats). Within that subset, higher marginal
 * pieces go first so a partial API success still lands the most valuable
 * activator.
 */
export function planLoadoutChanges(
  combo: ScoredCombo['artifacts'],
  current: ScoredCombo | undefined,
  settings: ArtifactOptimizerSettings,
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>,
): LoadoutChangePlan {
  const slots: ArtifactSlot[] = [1, 2, 3];
  const lockedSlots = slots.filter((position) =>
    isSlotLockedForEquip(current, position, slotLocks),
  );
  const currentBySlot = new Map<
    ArtifactSlot,
    ScoredCombo['artifacts'][number]
  >();
  const equippedArtifacts = current?.artifacts ?? [];
  for (const artifact of equippedArtifacts) {
    if (artifact.equippedPosition !== undefined) {
      currentBySlot.set(artifact.equippedPosition, artifact);
    }
  }

  const comboIds = new Set(combo.map((artifact) => artifact.instanceId));
  const placedIds = new Set<number>();
  const reservedSlots = new Set<ArtifactSlot>();
  const keptSlots = new Set<ArtifactSlot>();
  const kept: ScoredCombo['artifacts'] = [];

  for (const position of slots) {
    const equipped = currentBySlot.get(position);
    if (equipped && comboIds.has(equipped.instanceId)) {
      placedIds.add(equipped.instanceId);
      reservedSlots.add(position);
      keptSlots.add(position);
      kept.push(equipped);
      continue;
    }
    if (lockedSlots.includes(position)) {
      reservedSlots.add(position);
    }
  }

  const remaining = combo.filter(
    (artifact) => !placedIds.has(artifact.instanceId),
  );
  const freeSlots = slots.filter(
    (position) =>
      !reservedSlots.has(position) && !lockedSlots.includes(position),
  );

  const nowArtifacts = pickImmediateEquips(kept, remaining, freeSlots.length);
  const now: LoadoutChangePlan['now'] = [];
  for (const artifact of nowArtifacts) {
    const position = freeSlots.shift();
    if (position === undefined) {
      break;
    }
    const replaced = currentBySlot.get(position);
    now.push({
      artifactId: artifact.instanceId,
      position,
      displayName: artifact.displayName,
      ...(replaced && { replacedDisplayName: replaced.displayName }),
    });
    placedIds.add(artifact.instanceId);
  }

  const later = planLaterEquips({
    combo,
    placedIds,
    kept,
    nowArtifacts,
    slots,
    lockedSlots,
    keptSlots,
    leftoverFreeSlots: freeSlots,
    currentBySlot,
    settings,
    ...(slotLocks && { slotLocks }),
  });
  const waitTargets =
    later.length > 0 ? later.map((change) => change.position) : lockedSlots;
  const waitMs = Math.max(
    0,
    ...waitTargets.map((position) =>
      slotCooldownRemainingMs(position, currentBySlot, settings, slotLocks),
    ),
  );
  return {
    now,
    later,
    laterNames: later.map((item) => plannedEquipLabel(item)),
    lockedSlots,
    waitMs,
  };
}

function slotCooldownRemainingMs(
  position: ArtifactSlot,
  currentBySlot: Map<ArtifactSlot, ScoredCombo['artifacts'][number]>,
  settings: ArtifactOptimizerSettings,
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>,
): number {
  const equippedSlotLocked = currentBySlot.get(position)?.slotLocked;
  return showroomCooldownRemainingMs(settings, position, {
    ...(slotLocks && { slotLocks }),
    ...(typeof equippedSlotLocked === 'boolean' && {
      equippedSlotLocked,
    }),
  });
}

function planLaterEquips(options: {
  combo: ScoredCombo['artifacts'];
  placedIds: Set<number>;
  kept: ScoredCombo['artifacts'];
  nowArtifacts: ScoredCombo['artifacts'];
  slots: ArtifactSlot[];
  lockedSlots: ArtifactSlot[];
  keptSlots: Set<ArtifactSlot>;
  leftoverFreeSlots: ArtifactSlot[];
  currentBySlot: Map<ArtifactSlot, ScoredCombo['artifacts'][number]>;
  settings: ArtifactOptimizerSettings;
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>;
}): LoadoutChangePlan['later'] {
  const laterSlots = options.slots
    .filter(
      (position) =>
        options.lockedSlots.includes(position) &&
        !options.keptSlots.has(position),
    )
    .toSorted(
      (left, right) =>
        slotCooldownRemainingMs(
          left,
          options.currentBySlot,
          options.settings,
          options.slotLocks,
        ) -
        slotCooldownRemainingMs(
          right,
          options.currentBySlot,
          options.settings,
          options.slotLocks,
        ),
    );
  laterSlots.push(...options.leftoverFreeSlots);
  const laterArtifacts = sortByMarginalEquipPriority(
    options.combo.filter(
      (artifact) => !options.placedIds.has(artifact.instanceId),
    ),
    [...options.kept, ...options.nowArtifacts],
  );
  const later: LoadoutChangePlan['later'] = [];
  for (const artifact of laterArtifacts) {
    const position = laterSlots.shift();
    if (position === undefined) {
      break;
    }
    const replaced = options.currentBySlot.get(position);
    later.push({
      artifactId: artifact.instanceId,
      position,
      displayName: artifact.displayName,
      ...(replaced && { replacedDisplayName: replaced.displayName }),
    });
  }
  return later;
}

/**
 * Target loadout in slot 1–3 order: keep pieces that stay, then fill free
 * slots from the equip plan, then assign remaining pieces to leftover slots.
 * Aligns Recommended names with Currently equipped so replacements line up.
 */
function artifactsInPlannedSlotOrder(
  combo: ScoredCombo['artifacts'],
  context: LoadoutLabelContext,
): ScoredCombo['artifacts'] {
  const plan = planLoadoutChanges(
    combo,
    context.current,
    context.settings,
    context.slotLocks,
  );
  const bySlot = new Map<ArtifactSlot, ScoredCombo['artifacts'][number]>();
  const comboById = new Map(
    combo.map((artifact) => [artifact.instanceId, artifact]),
  );
  const currentArtifacts = context.current?.artifacts ?? [];
  for (const artifact of currentArtifacts) {
    if (
      artifact.equippedPosition !== undefined &&
      comboById.has(artifact.instanceId)
    ) {
      bySlot.set(artifact.equippedPosition, artifact);
    }
  }
  for (const change of plan.now) {
    placeComboInSlot(bySlot, comboById, change.artifactId, change.position);
  }
  for (const change of plan.later) {
    placeComboInSlot(bySlot, comboById, change.artifactId, change.position);
  }
  const ordered: ScoredCombo['artifacts'] = [];
  for (const position of [1, 2, 3] as const) {
    const artifact = bySlot.get(position);
    if (!artifact) {
      continue;
    }
    ordered.push({ ...artifact, equippedPosition: position });
  }
  return ordered;
}

function placeComboInSlot(
  bySlot: Map<ArtifactSlot, ScoredCombo['artifacts'][number]>,
  comboById: Map<number, ScoredCombo['artifacts'][number]>,
  artifactId: number,
  position: ArtifactSlot | undefined,
): void {
  if (position === undefined) {
    return;
  }
  const incoming = comboById.get(artifactId);
  if (!incoming) {
    return;
  }
  bySlot.set(position, incoming);
}

/**
 * Stamp slot-ordered display copies on every loadout the UI labels. Call once
 * after optimize so comboLabel / loadoutLabel stay argument-free.
 */
export function attachLoadoutDisplayOrder(
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
): OptimizerResult {
  const context: LoadoutLabelContext = {
    settings,
    ...(result.current !== undefined && { current: result.current }),
    ...(result.slotLocks !== undefined && { slotLocks: result.slotLocks }),
  };
  const decorate = (combo: ScoredCombo | undefined): void => {
    if (!combo) {
      return;
    }
    combo.displayArtifacts = artifactsInPlannedSlotOrder(
      combo.artifacts,
      context,
    );
  };
  decorate(result.best);
  decorate(result.current);
  for (const combo of result.alternatives) {
    decorate(combo);
  }
  decorate(result.allArpLoadout);
  decorate(result.monthlyMetaLoadout);
  decorate(result.marketDiscountLoadout);
  if (result.deferredAllArp) {
    result.deferredAllArp.displayArtifacts = artifactsInPlannedSlotOrder(
      result.deferredAllArp.artifacts,
      context,
    );
  }
  if (result.deferredSteam) {
    result.deferredSteam.displayArtifacts = artifactsInPlannedSlotOrder(
      result.deferredSteam.artifacts,
      context,
    );
  }
  return result;
}

export function artifactsAfterImmediateEquip(
  current: OptimizerResult['current'],
  best: NonNullable<OptimizerResult['best']>,
  plan: LoadoutChangePlan,
): ScoredCombo['artifacts'] {
  const bySlot = new Map<ArtifactSlot, ScoredCombo['artifacts'][number]>();
  const equipped = current?.artifacts ?? [];
  for (const artifact of equipped) {
    if (artifact.equippedPosition !== undefined) {
      bySlot.set(artifact.equippedPosition, artifact);
    }
  }
  for (const change of plan.now) {
    const incoming = best.artifacts.find(
      (artifact) => artifact.instanceId === change.artifactId,
    );
    if (!incoming) {
      continue;
    }
    bySlot.set(change.position, {
      ...incoming,
      equippedPosition: change.position,
    });
  }
  return bySlot.values().toArray();
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
