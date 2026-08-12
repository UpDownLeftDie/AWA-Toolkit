import type { ArtifactDefinition, ArtifactTier } from '../data';
import { displayNameFor } from '../data';
import type { OwnedArtifact } from '../scraper';
import {
  battlePassClaimableArp,
  breakDownCommunityEventPending,
  canEarnCommunityEventArp,
  describeWaitingCommunityArpLine,
  formatCommunityEta,
  formatCommunityEventArp,
  isActivityPending,
} from '../siteState';
import { collectBonuses } from './bonuses';
import {
  hasAllArpEffect,
  hasInventoryAllArp,
  resolveDeferredAllArp,
  shouldDeferBattlePassForContext,
} from './search';
import { communityEventArpInSwapWindow } from './scoring';
import type { OptimizerContext, ScoredCombo } from './types';

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
  if (!event?.isLive || event.pendingArp <= 0) {
    return;
  }
  if (!canEarnCommunityEventArp(event)) {
    return;
  }

  const breakdown = breakDownCommunityEventPending(event);
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
    communityEventArpInSwapWindow(context.siteState) > 0
  ) {
    notes.push(
      `${summary} — grants during this lock (once). Watch Twitch repeats daily; wear All-ARP% for the lump.`,
    );
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
  if (breakdown.imminentArp > 0) {
    return `${formatCommunityEventArp(breakdown.imminentArp)} may already be awarding`;
  }
  return `${formatCommunityEventArp(event.pendingArp)} still open`;
}

export function collectNotes(
  owned: OwnedArtifact[],
  equipped: OwnedArtifact[],
  best: ScoredCombo | undefined,
  context: OptimizerContext,
): string[] {
  const notes: string[] = [];
  appendBattlePassNotes(notes, owned, equipped, context);
  appendCommunityEventNotes(notes, owned, equipped, context);

  if (
    best &&
    isActivityPending(context.siteState.caps, 'steamQuests') &&
    equipped.length > 0
  ) {
    const currentSteam = collectBonuses(equipped).steamQuests;
    if (best.steamQuestsFlat < currentSteam) {
      notes.push(
        `Steam Quests still look unfinished — finish them before swapping away from your +${currentSteam} Steam Quests bonus (equip before starting quests).`,
      );
    } else if (currentSteam === 0 && best.steamQuestsFlat > 0) {
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
