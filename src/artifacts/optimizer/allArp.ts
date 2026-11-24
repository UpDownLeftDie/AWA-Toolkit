import { ARTIFACT_SETS } from '../data';
import type { OwnedArtifact } from '../scraper';
import {
  battlePassClaimableArp,
  battlePassRemainingMs,
  type SiteState,
} from '../siteState';
import {
  type ArtifactOptimizerSettings,
  type ArtifactSlotPosition,
} from '../settings';
import { collectBonuses } from './bonuses';
import {
  combinations,
  comboEquipWaitMs,
  currentLoadout,
  resolveNow,
  resolveOwnedList,
} from './context';
import type { OptimizerContext } from './types';

const BP_CLAIM_BUFFER_MS = 10 * 60 * 1000;
const deferBattlePassCache = new WeakMap<OptimizerContext, boolean>();

export function hasAllArpEffect(artifacts: OwnedArtifact[]): boolean {
  return collectBonuses(artifacts).allArpPct > 0;
}

export function canAssembleAllArp(owned: OwnedArtifact[]): boolean {
  const ids = new Set(owned.map((artifact) => artifact.familyId));
  if (ids.has('herkow-plasma-chamber')) {
    return true;
  }
  const zorathian = ARTIFACT_SETS.find(
    (set) => set.id === 'zorathian-renaissance',
  );
  return zorathian?.memberIds.every((id) => ids.has(id)) === true;
}

export function hasInventoryAllArp(owned: OwnedArtifact[]): boolean {
  return canAssembleAllArp(owned) || hasAllArpEffect(owned);
}

export function unconstrainedAllArpCombo(
  owned: OwnedArtifact[],
): OwnedArtifact[] | undefined {
  if (owned.length === 0) {
    return undefined;
  }
  const size = Math.min(3, owned.length);
  let best: OwnedArtifact[] | undefined;
  let bestPct = 0;
  for (const combo of combinations(owned, size)) {
    const pct = collectBonuses(combo).allArpPct;
    if (pct <= bestPct) {
      continue;
    }

    bestPct = pct;
    best = combo;
  }
  return bestPct > 0 ? best : undefined;
}

// When the All-ARP% set can actually go on (per-slot remaining), not a flat 24h.
export function allArpEquipWaitMs(
  owned: OwnedArtifact[],
  settings: ArtifactOptimizerSettings,
  slotLocks?: Partial<Record<ArtifactSlotPosition, boolean>>,
  now = Date.now(),
): number | undefined {
  if (hasAllArpEffect(currentLoadout(owned))) {
    return 0;
  }
  const combo = unconstrainedAllArpCombo(owned);
  return combo ? comboEquipWaitMs(combo, owned, settings, slotLocks, now) : undefined;
}

// Hold BP ARP Boosts while All-ARP% is off and the season still has time.
// Also used while scoring so All-ARP% is not inflated by a claim that may wait.
// Do not swap onto All-ARP% just because a boost is ready — twitch / community
// can be worth more, and All-ARP% may go on later for those. Claim when already
// wearing it, or when the season ends before it can go on.
export function shouldWaitForAllArpBeforeBattlePass(
  owned: OwnedArtifact[],
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  slotLocks?: Partial<Record<ArtifactSlotPosition, boolean>>,
  now = Date.now(),
): boolean {
  if (!hasInventoryAllArp(owned) || hasAllArpEffect(currentLoadout(owned)) || (battlePassClaimableArp(siteState.battlePass) <= 0)) {
    return false;
  }
  const waitMs = allArpEquipWaitMs(owned, settings, slotLocks, now);
  if (waitMs === undefined) {
    return false;
  }
  const bpLeft = battlePassRemainingMs(siteState.battlePass, now);
  return bpLeft === undefined || waitMs + BP_CLAIM_BUFFER_MS < bpLeft;
}

export function shouldDeferBattlePassForContext(
  context: OptimizerContext,
): boolean {
  const cached = deferBattlePassCache.get(context);
  if (cached !== undefined) {
    return cached;
  }
  const shouldDefer = shouldWaitForAllArpBeforeBattlePass(
    resolveOwnedList(context),
    context.settings,
    context.siteState,
    context.snapshot.slotLocks,
    resolveNow(context),
  );
  deferBattlePassCache.set(context, shouldDefer);
  return shouldDefer;
}
