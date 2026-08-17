import { areAccountActionsEnabled, getArtifactSettings } from '../settings';
import {
  battlePassClaimableArp,
  battlePassReadyNonArp,
  claimAllBattlePassRewards,
  listBattlePassClaimButtons,
  loadSiteState,
  refreshSiteStateFromPage,
  saveSiteState,
  waitForBattlePassDocument,
} from '../siteState';
import {
  didAllowAccountActions,
  didConfirmAoDialog,
  showAoAlert,
  showAoToast,
} from './dialog';

const BP_CLAIM_ALL_PENDING_KEY = 'ao-bp-claim-all';
const BP_CLAIM_SKIP_ARP_VALUE = 'skip-arp';

async function persistBattlePassAfterClaim(options: {
  claimed: number;
  remaining: number;
  shouldSkipArpBoosts: boolean;
}): Promise<void> {
  const state = await refreshSiteStateFromPage();
  const battlePass = state.battlePass;
  if (
    battlePass &&
    options.claimed > 0 &&
    !location.pathname.includes('/battle-pass')
  ) {
    if (options.shouldSkipArpBoosts) {
      const leftover = (battlePass.readyClaims ?? []).filter(
        (claim) => claim.isArp,
      );
      const next = {
        ...battlePass,
        readyToClaim: leftover.length,
        readyToClaimArp: leftover.length,
      };
      if (leftover.length > 0) {
        next.readyClaims = leftover;
      } else {
        delete next.readyClaims;
      }
      state.battlePass = next;
    } else if (options.remaining === 0) {
      const next = {
        ...battlePass,
        readyToClaim: 0,
        readyToClaimArp: 0,
      };
      delete next.readyClaims;
      state.battlePass = next;
    } else {
      state.battlePass = {
        ...battlePass,
        readyToClaim: Math.max(0, battlePass.readyToClaim - options.claimed),
      };
    }
  }
  await saveSiteState(state);
}

async function runBattlePassClaims(options: {
  shouldSkipArpBoosts: boolean;
}): Promise<void> {
  const shouldSkipArpBoosts = options.shouldSkipArpBoosts;
  showAoToast(
    shouldSkipArpBoosts
      ? 'Claiming Battle Pass rewards (leaving ARP Boosts)…'
      : 'Claiming Battle Pass rewards…',
  );
  const siteState = await loadSiteState();
  const readyClaims = siteState?.battlePass?.readyClaims;
  const { claimed, remaining, needsBattlePassPage } =
    await claimAllBattlePassRewards({
      shouldSkipArpBoosts,
      ...(readyClaims && { readyClaims }),
    });
  if (needsBattlePassPage === true) {
    showAoToast('Opening Battle Pass to claim…');
    sessionStorage.setItem(
      BP_CLAIM_ALL_PENDING_KEY,
      shouldSkipArpBoosts ? BP_CLAIM_SKIP_ARP_VALUE : '1',
    );
    const state = await loadSiteState();
    location.assign(state?.battlePass?.url ?? '/control-center/battle-pass/1');
    return;
  }
  try {
    await persistBattlePassAfterClaim({
      claimed,
      remaining,
      shouldSkipArpBoosts,
    });
  } catch (error) {
    console.error(
      '[AWA Toolkit] Failed to refresh Battle Pass after claim',
      error,
    );
  }
  if (claimed === 0) {
    await showAoAlert('Could not claim any Battle Pass rewards.');
    return;
  }
  if (remaining > 0) {
    await showAoAlert(
      `Claimed ${claimed}. ${remaining} still showing CLAIM — try Claim all again.`,
    );
    return;
  }
  if (shouldSkipArpBoosts) {
    showAoToast(
      `Claimed ${claimed} Battle Pass reward(s). ARP Boosts were left for All-ARP%.`,
    );
    return;
  }
  showAoToast(`Claimed ${claimed} Battle Pass reward(s).`);
}

export async function handleClaimAllBattlePass(
  options: { shouldSkipArpBoosts?: boolean } = {},
): Promise<void> {
  if (!(await didAllowAccountActions())) {
    return;
  }
  const isOnBattlePassPage = location.pathname.includes('/battle-pass');
  const liveAll = isOnBattlePassPage
    ? listBattlePassClaimButtons().length
    : 0;
  const liveNonArp = isOnBattlePassPage
    ? listBattlePassClaimButtons(document, { shouldSkipArpBoosts: true })
        .length
    : 0;
  const state = await loadSiteState();
  const battlePass = state?.battlePass;
  const ready = liveAll > 0 ? liveAll : (battlePass?.readyToClaim ?? 0);
  const arp = battlePassClaimableArp(battlePass);
  const nonArp =
    liveNonArp > 0 ? liveNonArp : battlePassReadyNonArp(battlePass);
  const shouldSkipArpBoosts =
    options.shouldSkipArpBoosts === true && arp > 0;
  const claimable = shouldSkipArpBoosts ? nonArp : ready;
  if (claimable <= 0) {
    await showAoAlert('No Battle Pass rewards are ready to claim.');
    return;
  }
  const arpBoostLabel = arp === 1 ? 'ARP Boost' : 'ARP Boosts';
  const arpBoostPart = arp > 0 ? ` (${arp} ${arpBoostLabel})` : '';
  const confirmMessage = shouldSkipArpBoosts
    ? `Claim ${nonArp} Battle Pass reward(s) now, and leave ${arp} ${arpBoostLabel} until All-ARP% is equipped?`
    : `Claim all ${ready} ready Battle Pass reward(s)${arpBoostPart}?`;
  const isOk = await didConfirmAoDialog(confirmMessage, {
    title: 'Claim Battle Pass',
    confirmLabel: shouldSkipArpBoosts ? 'Claim (skip ARP)' : 'Claim all',
  });
  if (!isOk) {
    return;
  }
  await runBattlePassClaims({ shouldSkipArpBoosts });
}

export async function consumePendingBattlePassClaimAll(): Promise<void> {
  const pending = sessionStorage.getItem(BP_CLAIM_ALL_PENDING_KEY);
  if (pending !== '1' && pending !== BP_CLAIM_SKIP_ARP_VALUE) {
    return;
  }
  if (!areAccountActionsEnabled(await getArtifactSettings())) {
    sessionStorage.removeItem(BP_CLAIM_ALL_PENDING_KEY);
    showAoToast('Account actions are off. Enable them in the full panel.');
    return;
  }
  sessionStorage.removeItem(BP_CLAIM_ALL_PENDING_KEY);
  await waitForBattlePassDocument();
  await runBattlePassClaims({
    shouldSkipArpBoosts: pending === BP_CLAIM_SKIP_ARP_VALUE,
  });
}

export function bindClaimAllButtons(root: ParentNode): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    '.ao-claim-btn',
  )) {
    button.addEventListener('click', () => {
      void handleClaimAllBattlePass({
        shouldSkipArpBoosts: button.dataset.skipArp === '1',
      });
    });
  }
}
