import type { OptimizerResult, ScoredCombo } from '../optimizer/types';
import {
  type ArtifactSlot,
  planLoadoutChanges,
} from '../optimizer/swapPlan';
import {
  showroomCooldownRemainingMs,
  type ArtifactOptimizerSettings,
} from '../settings';
import { formatMs } from '../loadoutFormat';

// Re-export domain swap-planning symbols so existing imports keep working.
export type { ArtifactSlot, LoadoutChangePlan } from '../optimizer/swapPlan';
export {
  artifactsAfterImmediateEquip,
  hasAnySlotOnCooldown,
  isSlotLockedForEquip,
  maxSlotCooldownMs,
  planLoadoutChanges,
  plannedEquipLabel,
} from '../optimizer/swapPlan';

// Shared format/label helpers (also used by plan domain).
export {
  artifactsForDisplay,
  comboLabel,
  formatMs,
  isSameLoadout,
  loadoutLabel,
  loadoutSetNames,
  msUntilUtcMidnight,
  sortArtifactsForDisplay,
  utcResetDeadlineLabel,
} from '../loadoutFormat';

/**
Per-slot cooldown labels (same shape as the panel note). Prefer this over a
single max/min — slots unlock independently.
*/
export function formatLockedSlotParts(
  settings: ArtifactOptimizerSettings,
  lockedSlots: ArtifactSlot[],
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>,
  now = Date.now(),
): string[] {
  return lockedSlots.map((position) => {
    const remaining = showroomCooldownRemainingMs(settings, position, {
      now,
      ...(slotLocks && { slotLocks }),
    });
    const entry = settings.slotCooldowns.find(
      (slot) => slot.position === position,
    );
    const estimateTag = entry?.estimated === true ? ', estimated' : '';
    return remaining <= 0 ? `slot ${position} (locked${estimateTag})` : `slot ${position} (${formatMs(remaining)} left${estimateTag})`;
  });
}

interface LoadoutLabelContext {
  current?: ScoredCombo;
  settings: ArtifactOptimizerSettings;
  slotLocks?: Partial<Record<ArtifactSlot, boolean>>;
}

/**
Target loadout in slot 1–3 order: keep pieces that stay, then fill free
slots from the equip plan, then assign remaining pieces to leftover slots.
Aligns Recommended names with Currently equipped so replacements line up.
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
Stamp slot-ordered display copies on every loadout the UI labels. Call once
after optimize so comboLabel / loadoutLabel stay argument-free.
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

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
