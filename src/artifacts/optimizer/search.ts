import {
  ARTIFACT_SETS,
  ArtifactEffectType,
  ArtifactTier,
  BASE_ACTIVITY,
  displayNameFor,
  artifactTierAt,
  fragmentCostToUpgradeFrom,
  getArtifactById,
  getNumericEffect,
  MONTHLY_ARP_FOR_PCT,
  MONTHLY_CATEGORY_USES,
  monthlyMetaStandingFamilies,
  upgradeFocusOrder,
} from '../data';
import type { OwnedArtifact } from '../scraper';
import {
  COOLDOWN_MS,
  utcDailyEndBufferMs,
  type ArtifactOptimizerSettings,
  type ArtifactSlotPosition,
} from '../settings';
import {
  battlePassClaimableArp,
  battlePassRemainingMs,
  canEarnCommunityEventArp,
  estimateCommunityUnlockAt,
  isActivityAvailable,
  isActivityPending,
  scrapedRemainingSteamQuestRewards,
  twitchWatchRemainingMs,
  waitingCommunityMilestones,
  type SiteState,
} from '../siteState';
import { collectBonuses, type BonusBuckets } from './bonuses';
import {
  canCompleteInWearWindow,
  canCompleteOutsideWearWindow,
  combinations,
  combinationsWithPinned,
  comboEquipWaitMs,
  currentLoadout,
  isSameLoadout,
  isWeeklyForcedIntoLock,
  msUntilNextSteamQuestWeek,
  msUntilNextUtcMidnight,
  pinnedEquippedArtifacts,
  resolveNow,
  resolveOwnedList,
} from './context';
import { communityEventArpInSwapWindow, scoreCombo } from './scoring';
import type {
  OptimizerContext,
  OptimizerResult,
  ScoredCombo,
  UpgradeSuggestion,
} from './types';

const BP_CLAIM_BUFFER_MS = 10 * 60 * 1000;
const MS_PER_DAY = 86_400_000;
const TWITCH_MS_PER_ARP = 60_000;
const TIME_ON_SITE_DURATION_MS = BASE_ACTIVITY.timeOnSiteBasePerDay * 60_000;
const deferBattlePassCache = new WeakMap<OptimizerContext, boolean>();

const UPGRADE_PATH_MAX = 5;

function monthlyUpgradeGain(
  artifact: OwnedArtifact,
  toTier: ArtifactTier,
): number {
  const family = getArtifactById(artifact.familyId);
  if (!family || family.effectUnit === 'cosmetic') {
    return 0;
  }
  const delta =
    getNumericEffect(family, toTier) - getNumericEffect(family, artifact.tier);
  if (delta <= 0) {
    return 0;
  }
  if (family.effectType === ArtifactEffectType.AllArpPct) {
    return Math.round(delta * MONTHLY_ARP_FOR_PCT);
  }
  const uses = MONTHLY_CATEGORY_USES[family.effectType];
  return uses === undefined ? 0 : Math.round(delta * uses);
}

function withUpgradedArtifact(
  artifact: OwnedArtifact,
  toTier: ArtifactTier,
): OwnedArtifact {
  const family = getArtifactById(artifact.familyId);
  const upgraded: OwnedArtifact = {
    ...artifact,
    tier: toTier,
    displayName: family ? displayNameFor(family, toTier) : artifact.displayName,
  };
  const nextCost = fragmentCostToUpgradeFrom(toTier);
  if (nextCost === undefined) {
    delete upgraded.upgradeCost;
  } else {
    upgraded.upgradeCost = nextCost;
  }
  return upgraded;
}

function replaceOwned(
  owned: OwnedArtifact[],
  instanceId: number,
  replacement: OwnedArtifact,
): OwnedArtifact[] {
  return owned.map((artifact) =>
    artifact.instanceId === instanceId ? replacement : artifact,
  );
}

function upgradeFocusRank(familyId: string, order: readonly string[]): number {
  const index = order.indexOf(familyId);
  return index === -1 ? order.length : index;
}

function nextUpgradeCandidate(
  owned: OwnedArtifact[],
  focusOrder: readonly string[],
): UpgradeSuggestion | undefined {
  const candidates: UpgradeSuggestion[] = [];
  for (const artifact of owned) {
    if (artifact.tier >= ArtifactTier.Interstellar) {
      continue;
    }
    const family = getArtifactById(artifact.familyId);
    const toTier = artifactTierAt(artifact.tier + 1);
    if (toTier === undefined || family?.effects[toTier] === undefined) {
      continue;
    }
    const fragmentCost =
      artifact.upgradeCost ?? fragmentCostToUpgradeFrom(artifact.tier);
    if (fragmentCost === undefined) {
      continue;
    }
    const arpGain = monthlyUpgradeGain(artifact, toTier);
    if (arpGain <= 0) {
      continue;
    }
    candidates.push({
      artifact,
      fromTier: artifact.tier,
      toTier,
      fragmentCost,
      arpGain,
      efficiency: arpGain / fragmentCost,
      isAffordable: false,
    });
  }
  return candidates.toSorted((left, right) => {
    const rankDelta =
      upgradeFocusRank(left.artifact.familyId, focusOrder) -
      upgradeFocusRank(right.artifact.familyId, focusOrder);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return right.arpGain === left.arpGain ? left.fragmentCost - right.fragmentCost : right.arpGain - left.arpGain;
  })[0];
}

/**
Long-term META upgrade path. Walks focus order one tier at a time. Marks
which steps the current fragment balance could cover (nothing is spent until
the user confirms Upgrade). The first unaffordable step is the save target;
leftover fragments are not suggested on cheaper sidegrades.
*/
export function suggestUpgrades(
  owned: OwnedArtifact[],
  fragments: number,
): UpgradeSuggestion[] {
  const focusOrder = upgradeFocusOrder(
    new Set(owned.map((artifact) => artifact.familyId)),
  );
  let remaining = fragments;
  let isSaving = false;
  let working = owned.map((artifact) => ({ ...artifact }));
  const path: UpgradeSuggestion[] = [];

  while (path.length < UPGRADE_PATH_MAX) {
    const next = nextUpgradeCandidate(working, focusOrder);
    if (!next) {
      break;
    }
    const isAffordable = !isSaving && next.fragmentCost <= remaining;
    if (isAffordable) {
      remaining -= next.fragmentCost;
    } else {
      isSaving = true;
    }
    const ownedName =
      owned.find((artifact) => artifact.instanceId === next.artifact.instanceId)
        ?.displayName ?? next.artifact.displayName;
    path.push({
      ...next,
      artifact: { ...next.artifact, displayName: ownedName },
      isAffordable,
    });
    working = replaceOwned(
      working,
      next.artifact.instanceId,
      withUpgradedArtifact(next.artifact, next.toTier),
    );
  }
  return path;
}

function siteStateAtNextUtcDay(state: SiteState, midnightMs: number): SiteState {
  const watchTwitch = state.watchTwitch;
  return {
    ...state,
    caps: {
      ...state.caps,
      timeOnSite: 'available',
      watchTwitch: 'available',
      dailyCalendar: 'available',
      dailyQuests: 'available',
    },
    ...(watchTwitch && {
      watchTwitch: {
        ...watchTwitch,
        scrapedAt: new Date(midnightMs + 1000).toISOString(),
        baseArp: 0,
        bonusArp: 0,
        timeWatched: 0,
        isUnderCap: true,
        remainingMs:
          watchTwitch.capArp *
          60_000,
      },
    }),
  };
}

function contextAtNextUtcDay(context: OptimizerContext): OptimizerContext {
  const now = resolveNow(context);
  const midnightMs = now + msUntilNextUtcMidnight(now);
  return {
    ...context,
    nowMs: midnightMs + 1000,
    siteState: siteStateAtNextUtcDay(context.siteState, midnightMs),
  };
}

/**
Today's leftover ToS / Twitch / instant dailies still fit before the UTC
cutoff, so do those on the current set before starting tomorrow's 24h lock.
*/
export function shouldPreloadNextUtcDayLoadout(
  context: OptimizerContext,
): boolean {
  const now = resolveNow(context);
  const untilMidnight = msUntilNextUtcMidnight(now);
  if (untilMidnight <= 0) {
    return false;
  }
  const cutoffMs = untilMidnight - utcDailyEndBufferMs(context.settings);
  if (cutoffMs <= 0) {
    return true;
  }
  const caps = context.siteState.caps;
  if (
    isActivityAvailable(caps, 'timeOnSite') &&
    TIME_ON_SITE_DURATION_MS <= cutoffMs
  ) {
    return false;
  }
  const twitchLeft = twitchWatchRemainingMs(
    context.siteState,
    0,
    new Date(now),
  );
  if (twitchLeft > 0 && twitchLeft <= cutoffMs) {
    return false;
  }
  if (
    isActivityPending(caps, 'dailyCalendar') ||
    isActivityPending(caps, 'dailyQuests')
  ) {
    return false;
  }
  return true;
}

/**
When today is idle (or past the UTC cutoff), wear tomorrow's 00:00 24h pick
now so the cooldown is already ticking at reset. Recycler-for-Monday-steam is
the usual case: waiting until 00:00 just delays the lock by the leftover hour.

If that pick is already equipped, still return it so today's idle 24h winner
does not swap it off for one dead hour.
*/
export function resolvePreloadNextUtcDayBest(
  owned: OwnedArtifact[],
  context: OptimizerContext,
  currentBest: ScoredCombo | undefined,
): ScoredCombo | undefined {
  if (!shouldPreloadNextUtcDayLoadout(context)) {
    return undefined;
  }
  const nextBest = findBestCombo(owned, contextAtNextUtcDay(context));
  if (!nextBest) {
    return undefined;
  }
  if (
    currentBest &&
    isSameLoadout(nextBest.artifacts, currentBest.artifacts)
  ) {
    return undefined;
  }
  const now = resolveNow(context);
  if (!isSameLoadout(nextBest.artifacts, currentLoadout(owned))) {
    const waitMs = comboEquipWaitMs(
      nextBest.artifacts,
      owned,
      context.settings,
      context.snapshot.slotLocks,
      now,
    );
    if (waitMs >= msUntilNextUtcMidnight(now)) {
      return undefined;
    }
  }
  return scoreCombo(nextBest.artifacts, context);
}

export function findBestCombo(
  owned: OwnedArtifact[],
  context: OptimizerContext,
): ScoredCombo | undefined {
  const deferred = resolveDeferredAllArp(owned, context);
  if (deferred) {
    const equipped = currentLoadout(owned);
    const frozen = findBestComboBy(
      owned,
      context,
      (combo) => combo.weeklyArp,
      (combo) =>
        combo.allArpPct > 0 || isSameLoadout(combo.artifacts, equipped),
    );
    if (frozen) {
      return frozen;
    }
  }
  const best = findBestComboBy(
    owned,
    context,
    (combo) => combo.weeklyArp,
    () => true,
  );
  const equipped = currentLoadout(owned);
  if (
    best &&
    best.allArpPct > 0 &&
    !isSameLoadout(best.artifacts, equipped)
  ) {
    const waitMs = comboEquipWaitMs(
      best.artifacts,
      owned,
      context.settings,
      context.snapshot.slotLocks,
      resolveNow(context),
    );
    if (
      waitMs > 0 &&
      !isAllArpWorthTheLock(best.artifacts, owned, context, waitMs)
    ) {
      return findBestComboBy(
        owned,
        context,
        (combo) => combo.weeklyArp,
        (combo) =>
          combo.allArpPct <= 0 || isSameLoadout(combo.artifacts, equipped),
      );
    }
  }
  return best;
}

/**
True when an All-ARP% lock starting at `waitMs` nets more lifetime ARP than
keeping the best flat set.

Twitch/ToS/dailies that still fit outside the lock (before equip or after
the 24h cooldown, by the user's UTC cutoff) are not a cost — do those on
the flat set. Calendar auto-claims at 00:00 UTC on whatever is equipped, so
a midnight inside the lock is forced. Community extra is lump × All-ARP%.
*/
export function isAllArpWorthTheLock(
  allArpArtifacts: OwnedArtifact[],
  owned: OwnedArtifact[],
  context: OptimizerContext,
  waitMs: number,
): boolean {
  const allArpBonuses = collectBonuses(allArpArtifacts);
  const alternative = bestFlatBonusesForLock(owned, context, waitMs);
  if (!alternative) {
    return true;
  }
  const lump = communityEventArpInSwapWindow(context.siteState, waitMs);
  const lumpExtra = lump * allArpBonuses.allArpPct;
  const forcedDelta = forcedDailyArpDelta(
    context.siteState,
    waitMs,
    allArpBonuses,
    alternative,
    utcDailyEndBufferMs(context.settings),
    resolveNow(context),
  );
  return lumpExtra + forcedDelta > 0;
}

function bestFlatBonusesForLock(
  owned: OwnedArtifact[],
  context: OptimizerContext,
  waitMs: number,
): BonusBuckets | undefined {
  const size = Math.min(3, owned.length);
  const pinned = pinnedEquippedArtifacts(
    owned,
    context.settings,
    context.siteState,
    context.snapshot.slotLocks,
  );
  let best: BonusBuckets | undefined;
  let bestArp = Number.NEGATIVE_INFINITY;
  const consider = (combo: OwnedArtifact[]): void => {
    const bonuses = collectBonuses(combo);
    if (bonuses.allArpPct > 0) {
      return;
    }
    const scored = scoreCombo(combo, context, waitMs).weeklyArp;
    if (best && scored <= bestArp) {
      return;
    }

    best = bonuses;
    bestArp = scored;
  };
  for (const combo of combinationsWithPinned(owned, size, pinned)) {
    consider(combo);
  }
  const equipped = currentLoadout(owned);
  if (equipped.length > 0) {
    consider(equipped);
  }
  return best;
}

function utcDayBounds(
  dayStartMs: number,
  midnight: number,
): { fromMs: number; untilMs: number } {
  return dayStartMs <= 0 ? { fromMs: 0, untilMs: midnight } : { fromMs: dayStartMs, untilMs: dayStartMs + MS_PER_DAY };
}

function isAutoClaimForcedIntoLock(dayStartMs: number, waitMs: number): boolean {
  return dayStartMs > waitMs && dayStartMs <= waitMs + COOLDOWN_MS;
}

function isTimedDailyForcedIntoLock(
  dayStartMs: number,
  waitMs: number,
  durationMs: number,
  midnight: number,
  deadlineBufferMs: number,
): boolean {
  const { fromMs, untilMs } = utcDayBounds(dayStartMs, midnight);
  return (
    canCompleteInWearWindow(fromMs, untilMs, waitMs, durationMs) &&
    !canCompleteOutsideWearWindow(
      fromMs,
      untilMs,
      waitMs,
      durationMs,
      COOLDOWN_MS,
      deadlineBufferMs,
    )
  );
}

function twitchDayArp(bonuses: BonusBuckets, siteState: SiteState, isToday: boolean): number {
  const cap =
    (siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) +
    bonuses.watchTwitch;
  const remaining = twitchWatchRemainingMs(siteState, bonuses.watchTwitch) / 60_000;
  const base = isToday ? remaining : cap;
  return base * (1 + bonuses.allArpPct);
}

function twitchDayDurationMs(
  bonuses: BonusBuckets,
  siteState: SiteState,
  isToday: boolean,
): number {
  const cap =
    (siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) +
    bonuses.watchTwitch;
  const remaining = twitchWatchRemainingMs(siteState, bonuses.watchTwitch) / 60_000;
  return (isToday ? remaining : cap) * TWITCH_MS_PER_ARP;
}

function forcedDailyArpDelta(
  siteState: SiteState,
  waitMs: number,
  allArp: BonusBuckets,
  flat: BonusBuckets,
  deadlineBufferMs: number,
  now: number,
): number {
  const midnight = msUntilNextUtcMidnight(now);
  let delta = 0;
  const twitchDays: number[] = [];
  if (twitchWatchRemainingMs(siteState, flat.watchTwitch) > 0) {
    twitchDays.push(0);
  }
  twitchDays.push(midnight, midnight + MS_PER_DAY);
  for (const dayStart of twitchDays) {
    if (dayStart > waitMs + COOLDOWN_MS) {
      continue;
    }
    const isToday = dayStart === 0;
    const duration = twitchDayDurationMs(flat, siteState, isToday);
    if (
      !isTimedDailyForcedIntoLock(
        dayStart,
        waitMs,
        duration,
        midnight,
        deadlineBufferMs,
      )
    ) {
      continue;
    }
    delta +=
      twitchDayArp(allArp, siteState, isToday) -
      twitchDayArp(flat, siteState, isToday);
  }

  const tosDays = [0, midnight, midnight + MS_PER_DAY].filter(
    (dayStart) =>
      (dayStart > 0 || isActivityAvailable(siteState.caps, 'timeOnSite')) &&
      isTimedDailyForcedIntoLock(
        dayStart,
        waitMs,
        TIME_ON_SITE_DURATION_MS,
        midnight,
        deadlineBufferMs,
      ),
  );
  if (tosDays.length > 0) {
    const allArpTos =
      (BASE_ACTIVITY.timeOnSiteBasePerDay + allArp.timeOnSite) *
      (1 + allArp.allArpPct);
    const flatTos =
      (BASE_ACTIVITY.timeOnSiteBasePerDay + flat.timeOnSite) *
      (1 + flat.allArpPct);
    delta += tosDays.length * (allArpTos - flatTos);
  }

  const calendarDays = [midnight, midnight + MS_PER_DAY].filter((dayStart) =>
    isAutoClaimForcedIntoLock(dayStart, waitMs),
  );
  if (calendarDays.length > 0) {
    const allArpCal =
      (BASE_ACTIVITY.dailyCalendarBasePerDay + allArp.dailyCalendar) *
      (1 + allArp.allArpPct);
    const flatCal =
      (BASE_ACTIVITY.dailyCalendarBasePerDay + flat.dailyCalendar) *
      (1 + flat.allArpPct);
    delta += calendarDays.length * (allArpCal - flatCal);
  }

  const questDays = [0, midnight, midnight + MS_PER_DAY].filter((dayStart) => {
    const isTodayDue =
      dayStart === 0 && isActivityAvailable(siteState.caps, 'dailyQuests');
    return (
      (dayStart !== 0 || isTodayDue) &&
      isTimedDailyForcedIntoLock(
        dayStart,
        waitMs,
        0,
        midnight,
        deadlineBufferMs,
      )
    );
  });
  for (const dayStart of questDays) {
    const onDay = new Date(now + dayStart);
    const weekend =
      onDay.getUTCDay() === 0 || onDay.getUTCDay() === 6
        ? BASE_ACTIVITY.weekendQuestBase
        : 0;
    const base = BASE_ACTIVITY.dailyQuestBase + weekend;
    delta += base * (1 + allArp.allArpPct) - base * (1 + flat.allArpPct);
  }

  return delta;
}

/**
Later community lump we can still All-ARP% if we do not start a new 24h lock.
75k in 5h with a 12h slot lock is a miss; every ARP gate after that is the
plan — do not drop them just because an optimistic ETA sits near the lock.
*/
export function resolveDeferredAllArp(
  owned: OwnedArtifact[],
  context: OptimizerContext,
): OptimizerResult['deferredAllArp'] | undefined {
  const event = context.siteState.communityEvent;
  if (!event?.isLive || !canEarnCommunityEventArp(event)) {
    return undefined;
  }
  if (hasAllArpEffect(currentLoadout(owned))) {
    return undefined;
  }
  const artifacts = unconstrainedAllArpCombo(owned);
  if (!artifacts) {
    return undefined;
  }
  const waitMs = allArpEquipWaitMs(
    owned,
    context.settings,
    context.snapshot.slotLocks,
    resolveNow(context),
  );
  if (waitMs === undefined || waitMs <= 0) {
    return undefined;
  }
  const waiting = waitingCommunityMilestones(event);
  const next = waiting[0];
  if (next === undefined) {
    return undefined;
  }
  const nextTarget = next.communityHoursRequired;
  const nextEta =
    nextTarget === undefined
      ? undefined
      : estimateCommunityUnlockAt(event, nextTarget);
  const isMissingNext = nextEta === undefined || nextEta.etaMs < waitMs;
  const later = isMissingNext ? waiting.slice(1) : waiting;
  const firstLater = later[0];
  if (firstLater === undefined) {
    return undefined;
  }
  const laterTarget = firstLater.communityHoursRequired;
  const laterEta =
    laterTarget === undefined
      ? undefined
      : estimateCommunityUnlockAt(event, laterTarget);
  const arpReward = later.reduce(
    (sum, milestone) => sum + milestone.arpReward,
    0,
  );
  const unlock: NonNullable<OptimizerResult['deferredAllArp']>['unlock'] = {
    arpReward,
  };
  if (laterTarget !== undefined) {
    unlock.targetHours = laterTarget;
  }
  if (laterEta !== undefined) {
    unlock.etaMs = laterEta.etaMs;
  }
  return isAllArpWorthTheLock(artifacts, owned, context, waitMs) ? { waitMs, artifacts, unlock } : undefined;
}

/**
Extra Steam ARP this week vs Twitch/calendar lost for one 24h lock.
Warrior Script +1 × 3 quests is not worth dropping Collapsed Star's Twitch day.
*/
function isExtraSteamWorthDisplacedDailies(
  best: ScoredCombo,
  steam: ScoredCombo,
  remainingQuests: number,
): boolean {
  const extra =
    (steam.steamQuestsFlat - best.steamQuestsFlat) * remainingQuests;
  if (extra <= 0) {
    return false;
  }
  const twitchLoss = Math.max(0, best.watchTwitchFlat - steam.watchTwitchFlat);
  const calendarLoss = Math.max(
    0,
    best.dailyCalendarFlat - steam.dailyCalendarFlat,
  );
  return extra > twitchLoss + calendarLoss;
}

/**
Steam Quests remaining this week normally win the 24h pick (dailies reset;
we pick a lock day). If a higher-value lock beat Steam (community All-ARP%),
still offer the Steam-flat set as a side swap after that wear — not instead
of it. Skip when the extra Steam flat costs more daily ARP than it adds.
*/
export function resolveDeferredSteam(
  owned: OwnedArtifact[],
  context: OptimizerContext,
  best: ScoredCombo | undefined,
): OptimizerResult['deferredSteam'] | undefined {
  if (!isActivityPending(context.siteState.caps, 'steamQuests')) {
    return undefined;
  }
  const remaining = scrapedRemainingSteamQuestRewards(context.siteState);
  if (!remaining || remaining.length === 0) {
    return undefined;
  }
  const steam = findBestSteamCombo(owned, context);
  if (!steam || steam.steamQuestsFlat <= 0) {
    return undefined;
  }
  const equipped = currentLoadout(owned);
  if (isSameLoadout(steam.artifacts, equipped)) {
    return undefined;
  }
  if (best && isSameLoadout(steam.artifacts, best.artifacts)) {
    return undefined;
  }
  if (
    collectBonuses(equipped).steamQuests >= steam.steamQuestsFlat
  ) {
    return undefined;
  }
  // +1 Steam per quest is not worth locking over a Twitch/calendar day.
  // Do Steam on the recommended set instead; skip the side swap.
  if (best && !isExtraSteamWorthDisplacedDailies(best, steam, remaining.length)) {
    return undefined;
  }
  const now = resolveNow(context);
  let waitMs = comboEquipWaitMs(
    steam.artifacts,
    owned,
    context.settings,
    context.snapshot.slotLocks,
    now,
  );
  // Side swap after the recommended 24h wear — including when that set is
  // already on. Immediate Recycler/Fission would lock over a better lock.
  // Wait is remaining recommended-equip time + 24h lock, not a >24h slot
  // cooldown (slots still cap at 24h).
  if (best) {
    waitMs = Math.max(
      waitMs,
      comboEquipWaitMs(
        best.artifacts,
        owned,
        context.settings,
        context.snapshot.slotLocks,
        now,
      ) + COOLDOWN_MS,
    );
  }
  return isWeeklyForcedIntoLock(msUntilNextSteamQuestWeek(now), waitMs) ? undefined : { waitMs, artifacts: steam.artifacts };
}

/**
When 24h ARP ties: prefer All-ARP% (Zorathian / HPC, Megumin community META),
then the currently equipped set so we don't swap for no gain.
*/
function comboTieBreakDelta(
  scored: ScoredCombo,
  best: ScoredCombo,
  equipped: OwnedArtifact[],
): number {
  if (scored.allArpPct !== best.allArpPct) {
    return scored.allArpPct - best.allArpPct;
  }
  const isScoredEquipped = isSameLoadout(scored.artifacts, equipped);
  const isBestEquipped = isSameLoadout(best.artifacts, equipped);
  if (isScoredEquipped === isBestEquipped) {
    return 0;
  }
  return isScoredEquipped ? 1 : -1;
}

/**
Pick the best owned 1–3 piece loadout by a primary metric, with totalScore
then All-ARP% / currently-equipped as tie-breaks.
*/
export function findBestComboBy(
  owned: OwnedArtifact[],
  context: OptimizerContext,
  primary: (combo: ScoredCombo) => number,
  isEligible: (combo: ScoredCombo) => boolean,
): ScoredCombo | undefined {
  if (owned.length === 0) {
    return undefined;
  }
  const size = Math.min(3, owned.length);
  const equipped = currentLoadout(owned);
  const pinned = pinnedEquippedArtifacts(
    owned,
    context.settings,
    context.siteState,
    context.snapshot.slotLocks,
  );
  let best: ScoredCombo | undefined;
  let bestPrimary = Number.NEGATIVE_INFINITY;
  for (const combo of combinationsWithPinned(owned, size, pinned)) {
    const scored = scoreCombo(combo, context);
    if (!isEligible(scored)) {
      continue;
    }
    const score = primary(scored);
    if (!(!best ||
      score > bestPrimary ||
      (score === bestPrimary && scored.totalScore > best.totalScore) ||
      (score === bestPrimary &&
        scored.totalScore === best.totalScore &&
        comboTieBreakDelta(scored, best, equipped) > 0))) {
      continue;
    }

    best = scored;
    bestPrimary = score;
  }
  return best;
}

export function findBestAllArpCombo(
  owned: OwnedArtifact[],
  context: OptimizerContext,
): ScoredCombo | undefined {
  return findBestComboBy(
    owned,
    context,
    (combo) => combo.allArpPct,
    (combo) => combo.allArpPct > 0,
  );
}

export function findBestSteamCombo(
  owned: OwnedArtifact[],
  context: OptimizerContext,
): ScoredCombo | undefined {
  return findBestComboBy(
    owned,
    context,
    (combo) => combo.steamQuestsFlat,
    (combo) => combo.steamQuestsFlat > 0,
  );
}

/**
Minimum market discount before Game Vault logic interrupts an ARP loadout.
Matches Light Warping Platinum (10%) / Stanley Excavation (15%). Weaker pieces
like Mysterious Text Decipher (2%) are not worth a 24h lock vs lifetime ARP.
*/
export const VAULT_PRIORITY_DISCOUNT_PCT = 0.1;

export function findBestMarketDiscountCombo(
  owned: OwnedArtifact[],
  context: OptimizerContext,
): ScoredCombo | undefined {
  return findBestComboBy(
    owned,
    context,
    (combo) => combo.marketDiscountPct,
    (combo) => combo.marketDiscountPct > 0,
  );
}

export function hasMarketDiscount(combo: ScoredCombo | undefined): boolean {
  return (
    combo !== undefined &&
    combo.artifacts.length > 0 &&
    combo.marketDiscountPct >= VAULT_PRIORITY_DISCOUNT_PCT
  );
}

function isMonthlyMetaEligible(artifact: OwnedArtifact): boolean {
  const family = getArtifactById(artifact.familyId);
  if (!family || family.effectUnit === 'cosmetic' || (family.effectType === ArtifactEffectType.None)) {
    return false;
  }
  if (
    family.effectType === ArtifactEffectType.AllArpPct &&
    getNumericEffect(family, artifact.tier) < 0
  ) {
    return false;
  }
  return true;
}

function bestOwnedOfFamily(
  owned: OwnedArtifact[],
  familyId: string,
  usedIds: ReadonlySet<number>,
): OwnedArtifact | undefined {
  return owned
    .filter(
      (artifact) =>
        artifact.familyId === familyId &&
        !usedIds.has(artifact.instanceId) &&
        isMonthlyMetaEligible(artifact),
    )
    .toSorted((left, right) => right.tier - left.tier)[0];
}

/**
Megumin ❌ Swap standing set from owned pieces. Missing families are filled
from the same META order (not by today's 24h score).
*/
export function findMonthlyMetaCombo(
  owned: OwnedArtifact[],
  context: OptimizerContext,
): ScoredCombo | undefined {
  const { standing, fillOrder } = monthlyMetaStandingFamilies(
    new Set(owned.map((artifact) => artifact.familyId)),
  );
  const picked: OwnedArtifact[] = [];
  const usedIds = new Set<number>();

  const tryAddFamily = (familyId: string): void => {
    if (picked.length >= 3) {
      return;
    }
    const artifact = bestOwnedOfFamily(owned, familyId, usedIds);
    if (!artifact) {
      return;
    }
    picked.push(artifact);
    usedIds.add(artifact.instanceId);
  };

  for (const familyId of standing) {
    tryAddFamily(familyId);
  }
  for (const familyId of fillOrder) {
    tryAddFamily(familyId);
  }
  return picked.length === 0 ? undefined : scoreCombo(picked, context);
}

export function suggestDailySwap(
  best: ScoredCombo,
  current: ScoredCombo | undefined,
): OptimizerResult['dailySwap'] {
  if (!current || current.artifacts.length < 3) {
    return undefined;
  }
  const currentIds = new Set(current.artifacts.map((a) => a.instanceId));
  const bestIds = new Set(best.artifacts.map((a) => a.instanceId));
  const toUnequip = current.artifacts.find((a) => !bestIds.has(a.instanceId));
  const toEquip = best.artifacts.find((a) => !currentIds.has(a.instanceId));
  if (!toUnequip || !toEquip) {
    return undefined;
  }
  return {
    unequip: toUnequip,
    equip: toEquip,
    reason: `Swap ${toUnequip.displayName} → ${toEquip.displayName} for +${
      best.totalScore - current.totalScore
    } estimated ARP in the next 24h swap window`,
  };
}

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

/**
When the All-ARP% set can actually go on (per-slot remaining), not a flat 24h.
*/
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

/**
Hold BP ARP Boosts while All-ARP% is off and the season still has time.
Also used while scoring so All-ARP% is not inflated by a claim that may wait.
Do not swap onto All-ARP% just because a boost is ready — twitch / community
can be worth more, and All-ARP% may go on later for those. Claim when already
wearing it, or when the season ends before it can go on.
*/
export function shouldWaitForAllArpBeforeBattlePass(
  owned: OwnedArtifact[],
  settings: ArtifactOptimizerSettings,
  siteState: SiteState,
  slotLocks?: Partial<Record<ArtifactSlotPosition, boolean>>,
): boolean {
  if (!hasInventoryAllArp(owned) || hasAllArpEffect(currentLoadout(owned)) || (battlePassClaimableArp(siteState.battlePass) <= 0)) {
    return false;
  }
  const waitMs = allArpEquipWaitMs(owned, settings, slotLocks);
  if (waitMs === undefined) {
    return false;
  }
  const bpLeft = battlePassRemainingMs(siteState.battlePass);
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
  );
  deferBattlePassCache.set(context, shouldDefer);
  return shouldDefer;
}
