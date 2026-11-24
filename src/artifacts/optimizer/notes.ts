import type { ArtifactDefinition, ArtifactTier } from '../data';
import { displayNameFor, resolveArtifactByDisplayName } from '../data';
import type { OwnedArtifact } from '../scraper';
import {
  battlePassClaimableArp,
  breakDownCommunityEventPending,
  canEarnCommunityEventArp,
  describeWaitingCommunityArpLine,
  formatCommunityEta,
  formatCommunityEventArp,
  fragmentOfferEndsAtMs,
  gameVaultOpensAtMs,
  isActivityPending,
  isGameVaultDiscountWindow,
  nextLockedCommunityArpMilestone,
  primaryExpiringFragmentOffer,
  vaultPayArp,
  type MarketplaceFragmentOffer,
} from '../siteState';
import { collectBonuses } from './bonuses';
import {
  isWeeklyForcedIntoLock,
  msUntilNextSteamQuestWeek,
  resolveNow,
} from './context';
import {
  hasAllArpEffect,
  hasInventoryAllArp,
  hasMarketDiscount,
  resolveDeferredAllArp,
  shouldDeferBattlePassForContext,
  VAULT_PRIORITY_DISCOUNT_PCT,
} from './search';
import {
  comboMarketDiscountPct,
  communityEventArpInSwapWindow,
  projectedRedeemableArp,
} from './scoring';
import type { OptimizerContext, ScoredCombo } from './types';
import { earliestSlotUnlockMs } from './vaultDiscount';

export function appendBattlePassNotes(
  notes: string[],
  owned: OwnedArtifact[],
  equipped: OwnedArtifact[],
  context: OptimizerContext,
): void {
  const bp = context.siteState.battlePass;
  const readyArp = battlePassClaimableArp(bp);
  if (!bp || readyArp <= 0) {
    return;
  }
  const hasOwnedAllArp = hasInventoryAllArp(owned);
  const hasAllArpOn = hasAllArpEffect(equipped);
  if (hasOwnedAllArp && !hasAllArpOn) {
    if (shouldDeferBattlePassForContext(context)) {
      return;
    }
    notes.push(
      `Claim ${readyArp} Battle Pass ARP Boost(s) now — Battle Pass ends before All-ARP% can be equipped.`,
    );
    return;
  }
  if (hasAllArpOn) {
    notes.push(
      `Claim ${readyArp} Battle Pass ARP Boost(s) now — All-ARP% is equipped.`,
    );
    return;
  }
  notes.push(`You have ${readyArp} Battle Pass ARP Boost(s) ready to claim.`);
}

export function appendCommunityEventNotes(
  notes: string[],
  owned: OwnedArtifact[],
  equipped: OwnedArtifact[],
  context: OptimizerContext,
): void {
  const event = context.siteState.communityEvent;
  if (!event?.isLive || !canEarnCommunityEventArp(event)) {
    return;
  }
  const breakdown = breakDownCommunityEventPending(event);
  if (
    breakdown.pendingCount <= 0 &&
    nextLockedCommunityArpMilestone(event) === undefined
  ) {
    return;
  }
  const summary = describeCommunityEventPendingNote(event, breakdown);
  const hasAllArpOwned = hasInventoryAllArp(owned);
  const hasAllArpOn = hasAllArpEffect(equipped);

  if (hasAllArpOwned && !hasAllArpOn && breakdown.waitingPersonalArp > 0) {
    notes.push(`${summary} — equip All-ARP% first.`);
    return;
  }

  if (
    hasAllArpOwned &&
    !hasAllArpOn &&
    communityEventArpInSwapWindow(context.siteState) > 0 &&
    resolveDeferredAllArp(owned, context) === undefined
  ) {
    notes.push(summary);
    return;
  }

  if (hasAllArpOwned && !hasAllArpOn && breakdown.waitingCommunityArp > 0) {
    const deferred = resolveDeferredAllArp(owned, context);
    if (deferred) {
      const hours =
        deferred.unlock.targetHours === undefined
          ? ''
          : ` before ${deferred.unlock.targetHours.toLocaleString()}h`;
      notes.push(
        `${summary} — hold this loadout; All-ARP% in ${formatCommunityEta(deferred.waitMs)}${hours} (${formatCommunityEventArp(deferred.unlock.arpReward)}).`,
      );
      return;
    }
    notes.push(`${summary} — consider All-ARP%.`);
    return;
  }

  notes.push(summary);
}

function describeCommunityEventPendingNote(
  event: NonNullable<OptimizerContext['siteState']['communityEvent']>,
  breakdown: ReturnType<typeof breakDownCommunityEventPending>,
): string {
  if (breakdown.waitingPersonalArp > 0) {
    return `${formatCommunityEventArp(breakdown.waitingPersonalArp)} unlocked by community`;
  }
  if (breakdown.waitingCommunityArp > 0) {
    return describeWaitingCommunityArpLine(
      event,
      breakdown.waitingCommunityArp,
    );
  }
  const nextLocked = nextLockedCommunityArpMilestone(event);
  if (nextLocked) {
    return describeWaitingCommunityArpLine(event, nextLocked.arpReward);
  }
  return breakdown.imminentArp > 0 ? `${formatCommunityEventArp(breakdown.imminentArp)} unlocked — not awarded yet` : `${formatCommunityEventArp(event.pendingArp)} still open`;
}

/**
Soft guidance for timed Artifacts/Fragments marketplace listings. Never
replaces the ARP-optimal loadout — only surfaces buy-before-expiry timing
and how it lines up with Game Vault discount windows.
*/
function isOwnedArtifactOffer(
  offer: MarketplaceFragmentOffer,
  ownedFamilyIds: ReadonlySet<string>,
): boolean {
  const resolved = resolveArtifactByDisplayName(offer.name);
  return (
    resolved !== undefined && ownedFamilyIds.has(resolved.definition.id)
  );
}

export function appendMarketplaceFragmentNotes(
  notes: string[],
  owned: OwnedArtifact[],
  equipped: OwnedArtifact[],
  best: ScoredCombo | undefined,
  discountCombo: ScoredCombo | undefined,
  context: OptimizerContext,
): void {
  const now = resolveNow(context);
  const discountPct = Math.max(
    comboMarketDiscountPct(discountCombo),
    comboMarketDiscountPct(best),
    collectBonuses(equipped).marketDiscountPct,
  );
  const availableArp = projectedRedeemableArp(
    context,
    best,
    discountCombo,
  );
  const ownedFamilyIds = new Set(owned.map((artifact) => artifact.familyId));
  const offer = primaryExpiringFragmentOffer(context.siteState, {
    discountPct,
    ...(availableArp !== undefined && { availableArp }),
    now,
    shouldSkip: (candidate) =>
      isOwnedArtifactOffer(candidate, ownedFamilyIds),
  });
  if (!offer) {
    return;
  }
  const endsAt = fragmentOfferEndsAtMs(offer);
  if (endsAt === undefined) {
    return;
  }
  const eta = formatCommunityEta(Math.max(0, endsAt - now));
  const payArp = vaultPayArp(offer.price, discountPct);
  const hasDiscountSet =
    hasMarketDiscount(discountCombo) ||
    discountPct >= VAULT_PRIORITY_DISCOUNT_PCT;
  const discountLabel =
    discountPct > 0
      ? `${String(Math.round(discountPct * 100))}% off → ${String(payArp)} ARP`
      : `${String(offer.price)} ARP`;

  if (hasDiscountSet && isGameVaultDiscountWindow(context.siteState, now)) {
    notes.push(
      `Marketplace: buy ${offer.name} before ${eta} (${discountLabel}) — Game Vault is open; group the claim with your market-discount window.`,
    );
    return;
  }

  const opensAt = gameVaultOpensAtMs(context.siteState);
  if (
    hasDiscountSet &&
    opensAt !== undefined &&
    opensAt > now &&
    opensAt < endsAt
  ) {
    const vaultEta = formatCommunityEta(opensAt - now);
    notes.push(
      `Marketplace: ${offer.name} ends in ${eta} (${discountLabel}) — Game Vault opens in ${vaultEta}; buy with vault discount gear if you can wait.`,
    );
    return;
  }

  const unlockAt = earliestSlotUnlockMs(context, now);
  if (hasDiscountSet && endsAt <= unlockAt) {
    notes.push(
      `Marketplace: ${offer.name} ends in ${eta} (${discountLabel}) before slots unlock for discount gear — use marketplace discount prioritization or buy without the discount.`,
    );
    return;
  }

  if (hasDiscountSet && opensAt !== undefined && opensAt > endsAt) {
    notes.push(
      `Marketplace: ${offer.name} ends in ${eta} (${discountLabel}) before Game Vault opens — equip market-discount (or turn on prioritization) if you want the savings.`,
    );
    return;
  }

  notes.push(
    `Marketplace: buy ${offer.name} before ${eta} if you want it (${discountLabel}).`,
  );
}

export function collectNotes(
  owned: OwnedArtifact[],
  equipped: OwnedArtifact[],
  best: ScoredCombo | undefined,
  context: OptimizerContext,
  discountCombo?: ScoredCombo,
): string[] {
  const notes: string[] = [];
  appendBattlePassNotes(notes, owned, equipped, context);
  appendCommunityEventNotes(notes, owned, equipped, context);
  appendMarketplaceFragmentNotes(
    notes,
    owned,
    equipped,
    best,
    discountCombo,
    context,
  );

  if (
    isActivityPending(context.siteState.caps, 'steamQuests') &&
    equipped.length > 0
  ) {
    const currentSteam = collectBonuses(equipped).steamQuests;
    const ownedSteam = Math.max(
      currentSteam,
      best?.steamQuestsFlat ?? 0,
      ...owned.map((artifact) => collectBonuses([artifact]).steamQuests),
    );
    if (
      best &&
      best.steamQuestsFlat < currentSteam &&
      isWeeklyForcedIntoLock(
        msUntilNextSteamQuestWeek(resolveNow(context)),
        0,
      )
    ) {
      notes.push(
        `Steam Quests still look unfinished — finish them before swapping away from your +${currentSteam} Steam Quests bonus (equip before starting quests).`,
      );
    } else if (currentSteam === 0 && ownedSteam > 0) {
      notes.push(
        'Equip a Steam Quests artifact before starting any quest — Control Center still shows 15/25; real ARP is on the ARP Log.',
      );
    }
  }

  return notes;
}

export function describeArtifact(
  family: ArtifactDefinition,
  tier: ArtifactTier,
): string {
  return `${displayNameFor(family, tier)} (${family.category})`;
}
