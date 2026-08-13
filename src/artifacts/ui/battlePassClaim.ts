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
import { didConfirmAoDialog, showAoAlert, showAoToast } from './dialog';

const BP_CLAIM_ALL_PENDING_KEY = 'ao-bp-claim-all';
const BP_CLAIM_SKIP_ARP_VALUE = 'skip-arp';

async function runBattlePassClaims(options: {
  shouldSkipArpBoosts: boolean;
}): Promise<void> {
  const shouldSkipArpBoosts = options.shouldSkipArpBoosts;
  showAoToast(
    shouldSkipArpBoosts
      ? 'Claiming Battle Pass rewards (leaving ARP Boosts)…'
      : 'Claiming Battle Pass rewards…',
  );
  const { claimed, remaining, needsBattlePassPage } =
    await claimAllBattlePassRewards({ shouldSkipArpBoosts });
  if (needsBattlePassPage === true) {
    sessionStorage.setItem(
      BP_CLAIM_ALL_PENDING_KEY,
      shouldSkipArpBoosts ? BP_CLAIM_SKIP_ARP_VALUE : '1',
    );
    const state = await loadSiteState();
    location.assign(state?.battlePass?.url ?? '/control-center/battle-pass/1');
    return;
  }
  try {
    const state = await refreshSiteStateFromPage();
    await saveSiteState(state);
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
  sessionStorage.removeItem(BP_CLAIM_ALL_PENDING_KEY);
  await waitForBattlePassDocument();
  const shouldSkipArpBoosts = pending === BP_CLAIM_SKIP_ARP_VALUE;
  const ready = listBattlePassClaimButtons(document, {
    shouldSkipArpBoosts,
  }).length;
  if (ready === 0) {
    await showAoAlert('No Battle Pass CLAIM buttons were found on the page.');
    return;
  }
  await runBattlePassClaims({ shouldSkipArpBoosts });
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
