import { applyLoadout, upgradeArtifact } from '../api';
import type { ArtifactTier } from '../data';
import type { OptimizerResult, ScoredCombo } from '../optimizer';
import { applySnapshotUpgrade, isArtifactsShowroomPage } from '../scraper';
import {
  getArtifactSettings,
  saveArtifactSettings,
  type ArtifactOptimizerSettings,
} from '../settings';
import { didConfirmAoDialog, showAoAlert, showAoToast } from './dialog';
import { isControlCenterPage } from './gather';
import {
  formatLockedSlotParts,
  isSameLoadout,
  loadoutLabel,
  loadoutSetNames,
  planLoadoutChanges,
  type ArtifactSlot,
  type LoadoutChangePlan,
} from './loadoutPlan';
import { bindVaultDiscountActions } from './render';
import { injectControlCenterPanel, injectShowroomPanel } from './panels';

export async function persistFormSettings(root: ParentNode): Promise<void> {
  const settings = await getArtifactSettings();
  const activities = { ...settings.activities };
  for (const key of Object.keys(activities) as (keyof typeof activities)[]) {
    const enabled = root.querySelector<HTMLInputElement>(
      `input[data-activity="${CSS.escape(key)}"]`,
    )?.checked;
    const frequencyRaw =
      root.querySelector<HTMLInputElement>(
        `input[data-freq="${CSS.escape(key)}"]`,
      )?.value ?? '';
    const frequency = Number(frequencyRaw);
    activities[key] = {
      enabled: enabled ?? activities[key].enabled,
      frequency:
        frequencyRaw.trim() === '' || Number.isNaN(frequency)
          ? activities[key].frequency
          : frequency,
    };
  }

  const vaultInput = root.querySelector<HTMLInputElement>('#ao-vault-price');
  const fragsRaw =
    root.querySelector<HTMLInputElement>('#ao-manual-frags')?.value ?? '';
  const patch: Partial<ArtifactOptimizerSettings> = {
    activities,
  };
  if (vaultInput) {
    const vault = Number(vaultInput.value);
    patch.pendingVaultPurchaseArp = Number.isNaN(vault) ? 0 : vault;
  }
  const parsedFrags = Number(fragsRaw);
  if (fragsRaw.trim() !== '' && !Number.isNaN(parsedFrags)) {
    patch.manualFragments = parsedFrags;
  }
  await saveArtifactSettings(patch);
}

export async function confirmAndApplyLoadout(
  result: OptimizerResult,
  settings: ArtifactOptimizerSettings,
): Promise<void> {
  await confirmAndApplyCombo(
    result.best,
    result.current,
    settings,
    'recommended',
    result,
  );
}

export async function confirmAndApplyCombo(
  combo: ScoredCombo | undefined,
  current: ScoredCombo | undefined,
  settings: ArtifactOptimizerSettings,
  label: string,
  result?: OptimizerResult,
): Promise<void> {
  if (!combo || combo.artifacts.length === 0) {
    await showAoAlert(`No ${label} loadout available.`);
    return;
  }

  const resolved = await resolveLoadoutPlan(
    combo,
    current,
    settings,
    label,
    result,
  );
  if (!resolved) {
    return;
  }

  const currentlyEquipped = (current?.artifacts ?? [])
    .filter((a) => a.equippedPosition !== undefined)
    .map((a) => ({
      artifactId: a.instanceId,
      position: a.equippedPosition as ArtifactSlot,
    }));

  const { allOk, results } = await applyLoadout(
    resolved.now,
    currentlyEquipped,
  );
  notifyLoadoutResult(allOk, results, label);
}

function namedLoadout(
  label: string,
  activeSetNames: string[] | undefined,
): string {
  if (!activeSetNames || activeSetNames.length === 0) {
    return label;
  }
  return `${label} (${activeSetNames.join(', ')})`;
}

async function explainNothingToEquip(
  label: string,
  plan: LoadoutChangePlan,
  settings: ArtifactOptimizerSettings,
  options?: {
    allArpLabel?: string;
    slotLocks?: Partial<Record<ArtifactSlot, boolean>>;
    activeSetNames?: string[];
  },
): Promise<void> {
  const named = namedLoadout(label, options?.activeSetNames);
  const lines: string[] = [];
  if (plan.later.length > 0) {
    lines.push(`No unlocked slots for ${named} yet.`);
    if (plan.laterNames.length > 0) {
      lines.push(`Still needed: ${plan.laterNames.join(', ')}.`);
    }
  } else if (options?.allArpLabel) {
    lines.push(
      `The ${named} loadout is already equipped.`,
      `All-ARP% still needed:\n${options.allArpLabel}`,
    );
  } else {
    lines.push(`The ${named} loadout is already equipped.`);
  }
  if (plan.lockedSlots.length > 0) {
    const parts = formatLockedSlotParts(
      settings,
      plan.lockedSlots,
      options?.slotLocks,
    );
    lines.push(`Slots on cooldown: ${parts.join(', ')}.`);
  }
  lines.push('Use Refresh if lock icons look out of date.');
  await showAoAlert(lines.join('\n\n'));
}

function allArpTargetArtifacts(
  result: OptimizerResult | undefined,
): ScoredCombo['artifacts'] | undefined {
  const deferred = result?.deferredAllArp?.artifacts;
  if (deferred && deferred.length > 0) {
    return deferred;
  }
  const loadout = result?.allArpLoadout?.artifacts;
  if (loadout && loadout.length > 0) {
    return loadout;
  }
  return undefined;
}

/**
 * Recommended is already on — offer All-ARP% into free slots when available.
 */
async function resolveAllArpWhenRecommendedEquipped(
  current: ScoredCombo | undefined,
  settings: ArtifactOptimizerSettings,
  result: OptimizerResult | undefined,
  recommendedPlan: LoadoutChangePlan,
): Promise<LoadoutChangePlan | undefined> {
  const allArp = allArpTargetArtifacts(result);
  if (!allArp || isSameLoadout(current?.artifacts, allArp)) {
    await explainNothingToEquip('recommended', recommendedPlan, settings, {
      activeSetNames: loadoutSetNames(current?.artifacts),
      ...(result?.slotLocks && { slotLocks: result.slotLocks }),
    });
    return undefined;
  }

  const allArpLabel = loadoutLabel(allArp);
  const allArpSetNames = loadoutSetNames(allArp);
  const unlockedPlan = planLoadoutChanges(
    allArp,
    current,
    settings,
    result?.slotLocks,
  );
  if (unlockedPlan.now.length > 0) {
    const isOk = await didConfirmNormalEquip(
      unlockedPlan,
      'All-ARP%',
      settings,
      {
        activeSetNames: allArpSetNames,
        ...(result?.slotLocks && { slotLocks: result.slotLocks }),
      },
    );
    return isOk ? unlockedPlan : undefined;
  }

  await explainNothingToEquip('recommended', unlockedPlan, settings, {
    allArpLabel: namedLoadout(allArpLabel, allArpSetNames),
    activeSetNames: loadoutSetNames(current?.artifacts),
    ...(result?.slotLocks && { slotLocks: result.slotLocks }),
  });
  return undefined;
}

async function resolveLoadoutPlan(
  combo: ScoredCombo,
  current: ScoredCombo | undefined,
  settings: ArtifactOptimizerSettings,
  label: string,
  result?: OptimizerResult,
): Promise<LoadoutChangePlan | undefined> {
  const plan = planLoadoutChanges(
    combo.artifacts,
    current,
    settings,
    result?.slotLocks,
  );
  const activeSetNames = loadoutSetNames(combo.artifacts);
  if (plan.now.length > 0) {
    const isOk = await didConfirmNormalEquip(plan, label, settings, {
      activeSetNames,
      ...(result?.slotLocks && { slotLocks: result.slotLocks }),
    });
    return isOk ? plan : undefined;
  }

  if (plan.later.length > 0) {
    await explainNothingToEquip(label, plan, settings, {
      activeSetNames,
      ...(result?.slotLocks && { slotLocks: result.slotLocks }),
    });
    return undefined;
  }

  // Recommended complete — offer All-ARP% when that loadout still differs.
  if (label === 'recommended') {
    return resolveAllArpWhenRecommendedEquipped(
      current,
      settings,
      result,
      plan,
    );
  }

  await explainNothingToEquip(label, plan, settings, {
    activeSetNames,
    ...(result?.slotLocks && { slotLocks: result.slotLocks }),
  });
  return undefined;
}

async function didConfirmNormalEquip(
  plan: LoadoutChangePlan,
  label: string,
  settings: ArtifactOptimizerSettings,
  options?: {
    slotLocks?: Partial<Record<ArtifactSlot, boolean>>;
    activeSetNames?: string[];
  },
): Promise<boolean> {
  const nowLines = plan.now
    .map((change) => `${change.displayName} → slot ${change.position}`)
    .join('\n');
  const lockedNote =
    plan.lockedSlots.length > 0
      ? `\n\nLeaving locked as-is: ${formatLockedSlotParts(
          settings,
          plan.lockedSlots,
          options?.slotLocks,
        ).join(', ')}.`
      : '';
  const laterNote =
    plan.laterNames.length > 0
      ? `\nStill needed later: ${plan.laterNames.join(', ')}.`
      : '';
  return didConfirmAoDialog(
    `Equip ${namedLoadout(label, options?.activeSetNames)} into unlocked slot(s) now?\n\n${nowLines}${lockedNote}${laterNote}\n\nThis uses the live AWA API and starts a 24h cooldown per changed slot.`,
    { title: 'Equip loadout', confirmLabel: 'Equip' },
  );
}

function notifyLoadoutResult(
  isOk: boolean,
  results: { ok: boolean; error?: string; message?: string }[],
  label = 'recommended',
): void {
  const succeeded = results.filter((result) => result.ok).length;
  if (isOk) {
    if (results.length === 0) {
      void showAoAlert(`The ${label} loadout is already equipped.`);
      return;
    }
    showAoToast('Loadout applied. Reloading…');
    location.reload();
    return;
  }
  if (succeeded > 0) {
    showAoToast('Partial loadout applied. Reloading…');
    location.reload();
    return;
  }
  const failed = results.find((r) => !r.ok);
  const error =
    failed?.error ??
    failed?.message ??
    'Unknown error (slot may be locked for 24h)';
  void showAoAlert(`Failed to apply loadout: ${error}`);
}

export async function handleAddManual(root: HTMLElement): Promise<void> {
  const familyId =
    root.querySelector<HTMLSelectElement>('#ao-manual-family')?.value;
  if (!familyId) {
    return;
  }
  const tier = Number(
    root.querySelector<HTMLSelectElement>('#ao-manual-tier')?.value,
  ) as ArtifactTier;
  const settings = await getArtifactSettings();
  await saveArtifactSettings({
    manualArtifacts: [...settings.manualArtifacts, { familyId, tier }],
    preferScraped: false,
  });
}

export async function handleRemoveManual(index: number): Promise<void> {
  const settings = await getArtifactSettings();
  const manualArtifacts = settings.manualArtifacts.filter(
    (_, itemIndex) => itemIndex !== index,
  );
  await saveArtifactSettings({ manualArtifacts });
}

export async function handleUpgradeClick(
  instanceId: number,
  onChanged: () => Promise<void>,
): Promise<void> {
  const isOk = await didConfirmAoDialog(
    'Upgrade this artifact? This spends fragments and cannot be undone.',
    { title: 'Upgrade artifact', confirmLabel: 'Upgrade', isDanger: true },
  );
  if (!isOk) {
    return;
  }
  const upgradeResult = await upgradeArtifact(instanceId);
  if (!upgradeResult.ok) {
    await showAoAlert(
      `Upgrade failed: ${upgradeResult.error ?? upgradeResult.status}`,
    );
    return;
  }
  await applySnapshotUpgrade(instanceId);
  showAoToast('Artifact upgraded.');
  await onChanged();
  if (isControlCenterPage()) {
    void injectControlCenterPanel({ force: true });
  } else if (isArtifactsShowroomPage()) {
    void injectShowroomPanel({ force: true });
  }
}

export function bindDynamicBody(
  root: HTMLElement,
  onChanged: () => Promise<void>,
): void {
  root.querySelector('#ao-add-manual')?.addEventListener('click', () => {
    void handleAddManual(root).then(onChanged);
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    '.ao-remove-manual',
  )) {
    button.addEventListener('click', () => {
      void handleRemoveManual(Number(button.dataset.index)).then(onChanged);
    });
  }

  bindUpgradeButtons(root, onChanged);
  bindVaultDiscountActions(root, onChanged);
}

export function bindUpgradeButtons(
  root: ParentNode,
  onChanged: () => Promise<void>,
): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    '.ao-upgrade-btn',
  )) {
    button.addEventListener('click', () => {
      void handleUpgradeClick(Number(button.dataset.id), onChanged);
    });
  }
}
