import { ARTIFACT_CREDITS, ARTIFACTS, TIER_LABELS } from '../data';
import type {
  BreakdownLine,
  OptimizerResult,
  UpgradeSuggestion,
} from '../optimizer';
import type { ArtifactSnapshot } from '../scraper';
import type { ArtifactOptimizerSettings } from '../settings';
import { saveArtifactSettings } from '../settings';
import {
  type ActivityKey,
  battlePassRemainingMs,
  describeCommunityEventPendingParts,
  emptySiteState,
  type SiteState,
} from '../siteState';
import { shouldShowBattlePassClaimAll, shouldSkipArpInBattlePassClaimAll } from '../siteState/battlePass';
import { buildActionPlan, renderActionPlan } from './actionPlan';
import {
  comboLabel,
  escapeHtml,
  formatLockedSlotParts,
  formatMs,
  sortArtifactsForDisplay,
} from './loadoutPlan';

export function renderSectionDivider(): string {
  return '<hr class="ao-divider" />';
}

const SKELETON_BAR_WIDTHS = ['88%', '72%', '64%', '48%'] as const;

export function renderHydrateBanner(message: string): string {
  return `<div class="ao-hydrate" role="status" aria-live="polite"><span class="ao-spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span></div>`;
}

function renderSkeletonBars(): string {
  return SKELETON_BAR_WIDTHS.map(
    (width) => `<div class="ao-skel" style="width:${width}"></div>`,
  ).join('');
}

export function renderPanelError(message: string): string {
  return `
    <div class="ao-heading">Artifact Optimizer</div>
    <div class="ao-note">${escapeHtml(message)}</div>
  `;
}

export function renderPanelSkeleton(
  message = 'Loading recommendations…',
): string {
  return `
    <div class="ao-heading">Artifact Optimizer</div>
    ${renderHydrateBanner(message)}
    <div id="ao-action-plan" class="ao-skel-block">
      <div class="ao-heading">What to do</div>
      ${renderSkeletonBars()}
    </div>
    ${renderSectionDivider()}
    <div class="ao-skel-block">
      ${renderSkeletonBars()}
    </div>
    <div class="ao-actions">
      <button type="button" disabled>Equip Recommended</button>
      <button type="button" class="ao-secondary" disabled>Open Full Panel</button>
    </div>
  `;
}

export function renderModalSkeleton(): string {
  return `
    ${renderHydrateBanner('Loading recommendations…')}
    <div id="ao-action-plan" class="ao-skel-block">
      <div class="ao-heading">What to do</div>
      ${renderSkeletonBars()}
    </div>
    ${renderSectionDivider()}
    <div class="ao-skel-block">${renderSkeletonBars()}</div>
  `;
}

export function formatEquippedLabel(result: OptimizerResult): string {
  if (!result.current) {
    return 'None detected';
  }
  return sortArtifactsForDisplay(result.current.artifacts)
    .map((artifact) => {
      const isLocked = artifact.slotLocked === true;
      return isLocked
        ? `${artifact.displayName} (locked)`
        : artifact.displayName;
    })
    .join(' + ');
}

const ACTIVITY_LABELS: Record<string, string> = {
  timeOnSite: 'Time on Site',
  steamQuests: 'Steam Quests',
  watchTwitch: 'Watch Twitch',
  dailyCalendar: 'Daily Calendar',
  discordPoll: 'Discord Poll',
  dailyQuests: 'Daily / weekend quests',
  steamCommunityEvent: 'Steam Community Event',
};

const BREAKDOWN_LABELS: Record<string, string> = {
  ...ACTIVITY_LABELS,
  dailyQuests: 'Daily quests',
  weekendQuests: 'Weekend quests',
  battlePassClaims: 'Battle Pass claims',
};

function breakdownLabel(key: string): string {
  return BREAKDOWN_LABELS[key] ?? key;
}

function formatBreakdownLine(entry: BreakdownLine): string {
  const parts = [entry.base];
  if (entry.categoryBonus !== 0) {
    parts.push(entry.categoryBonus);
  }
  if (entry.allArpBonus !== 0) {
    parts.push(entry.allArpBonus);
  }
  if (parts.length === 1) {
    return `~${entry.total} ARP`;
  }
  return `~${entry.total} (${parts.join(' + ')})`;
}

export function renderBreakdown(result: OptimizerResult['best']): string {
  if (!result) {
    return '';
  }
  const rows = Object.entries(result.breakdown)
    .filter(([, entry]) => entry.total !== 0)
    .map(
      ([k, entry]) =>
        `<div class="ao-row ao-muted">${escapeHtml(breakdownLabel(k))}: ${formatBreakdownLine(entry)}</div>`,
    )
    .join('');
  return `
    ${
      result.activeSetNames.length > 0
        ? `<div class="ao-row"><strong>Set:</strong> ${escapeHtml(result.activeSetNames.join(', '))}</div>`
        : ''
    }
    <div class="ao-row">Estimated lock-window ARP: <strong>${result.weeklyArp}</strong></div>
    ${
      result.marketplaceSavingsArp > 0
        ? `<div class="ao-row">Market savings: <strong>${result.marketplaceSavingsArp}</strong></div>`
        : ''
    }
    <div class="ao-row">All ARP multiplier: <strong>${(
      result.allArpPct * 100
    ).toFixed(0)}%</strong></div>
    <details>
      <summary class="ao-muted">Breakdown</summary>
      ${rows}
    </details>
  `;
}

export function renderTextLink(
  label: string,
  url: string,
  dateAccessed?: string,
): string {
  const accessedSuffix = dateAccessed ? ` (on ${dateAccessed})` : '';
  return `<a class="ao-text-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>${accessedSuffix}`;
}

export function renderCredits(options?: { compact?: boolean }): string {
  if (ARTIFACT_CREDITS.length === 0) {
    return '';
  }

  const sourceLinks = ARTIFACT_CREDITS.map((source) =>
    renderTextLink(source.label, source.url, source.dateAccessed),
  ).join(', ');

  if (options?.compact) {
    return `<div class="ao-muted ao-credit">Sources: ${sourceLinks}</div>`;
  }

  const detailLinks = ARTIFACT_CREDITS.flatMap((source) => source.links ?? [])
    .map((link) => renderTextLink(link.label, link.url))
    .join(', ');
  const details = detailLinks ? ` · ${detailLinks}` : '';
  return `<div class="ao-muted ao-credit">Sources: ${sourceLinks}${details}</div>`;
}

/**
Notes already covered by the action plan — keep market / inventory extras only.
*/
export function renderVaultDiscountBlock(result: OptimizerResult): string {
  const hint = result.vaultDiscount;
  if (!hint || hint.dismissed || !hint.note) {
    return '';
  }
  return `<div class="ao-note ao-vault-discount">
    <div>${escapeHtml(hint.note)}</div>
    <div class="ao-note-actions">
      <button type="button" class="ao-secondary" data-ao-dismiss-vault="${escapeHtml(hint.cycleId)}">Skip vault discount</button>
    </div>
  </div>`;
}

function renderVaultDiscountRestore(result: OptimizerResult): string {
  if (!result.vaultDiscount?.dismissed) {
    return '';
  }
  return `<div class="ao-row">
    Game Vault discount recs skipped for this rotation
    <button type="button" class="ao-secondary" data-ao-restore-vault>Restore</button>
  </div>`;
}

async function applyVaultDiscountDismiss(cycleId: string): Promise<void> {
  await saveArtifactSettings({ vaultDiscountDismissedCycle: cycleId });
}

async function restoreVaultDiscountRecs(): Promise<void> {
  await saveArtifactSettings({ vaultDiscountDismissedCycle: '' });
}

export function bindVaultDiscountActions(
  root: ParentNode,
  onChanged: () => void | Promise<void>,
): void {
  const dismiss = root.querySelector<HTMLButtonElement>(
    '[data-ao-dismiss-vault]',
  );
  dismiss?.addEventListener('click', () => {
    const cycleId = dismiss.dataset.aoDismissVault;
    if (!cycleId) {
      return;
    }
    void applyVaultDiscountDismiss(cycleId).then(() => onChanged());
  });
  root
    .querySelector('[data-ao-restore-vault]')
    ?.addEventListener('click', () => {
      void restoreVaultDiscountRecs().then(() => onChanged());
    });
}

export function supplementalNotes(notes: string[]): string[] {
  return notes.filter((note) => {
    if (/Battle Pass ARP Boost/i.test(note)) {
      return false;
    }
    if (
      /All-ARP%/i.test(note) &&
      /community|unlocked by community/i.test(note)
    ) {
      return false;
    }
    if (/^~\d+\s*ARP\b/i.test(note)) {
      return false;
    }
    return true;
  });
}

function renderCommunityEventBlock(
  siteState: SiteState | undefined,
  options?: { detailed?: boolean },
): string {
  const event = siteState?.communityEvent;
  if (!event?.isLive) {
    return '';
  }
  const title = escapeHtml(event.title ?? 'Steam Community Event');
  const pendingParts =
    event.pendingArp > 0
      ? describeCommunityEventPendingParts(event)
      : undefined;
  const pending = pendingParts
    ? `<strong>${escapeHtml(pendingParts.text)}</strong>`
    : 'no pending ARP with a gate met';
  const lines = [
    `<div><strong>${title}</strong></div>`,
    `<div>${event.personalHours}h played · ${pending}</div>`,
  ];
  if (pendingParts?.later) {
    lines.push(`<div class="ao-muted">${escapeHtml(pendingParts.later)}</div>`);
  }
  if (options?.detailed) {
    const awardParts: string[] = [];
    if (event.awardedArp > 0) {
      awardParts.push(`${event.awardedArp} on event page`);
    }
    if ((event.receivedArpFromLog ?? 0) > 0) {
      awardParts.push(`${event.receivedArpFromLog} in ARP Log`);
    }
    if (awardParts.length > 0) {
      lines.push(
        `<div class="ao-muted">Awarded: ${awardParts.join(' · ')}</div>`,
      );
    }
  }
  lines.push(`<div>${renderTextLink('Open event', event.url)}</div>`);
  return `<div class="ao-note">${lines.join('')}</div>`;
}

function renderBattlePassBlock(
  siteState: SiteState | undefined,
  options: { showClaimAll?: boolean; shouldSkipArpBoosts?: boolean } = {},
): string {
  const bp = siteState?.battlePass;
  if (!bp) {
    return '';
  }
  const remaining = battlePassRemainingMs(bp);
  let endsPart = '';
  if (remaining !== undefined) {
    endsPart = ` · ends in ${formatMs(remaining)}`;
  } else if (bp.endsInText) {
    endsPart = ` · ends in ${escapeHtml(bp.endsInText)}`;
  }
  const lines: string[] = [
    `<div><strong>Battle Pass</strong> · ${bp.tokens ?? '?'} / ${bp.tokensMax ?? '?'} tokens${endsPart}</div>`,
  ];
  if (bp.readyToClaim > 0) {
    const arpBoostPart =
      bp.readyToClaimArp > 0 ? ` (${bp.readyToClaimArp} ARP Boost)` : '';
    lines.push(
      `<div><strong>${bp.readyToClaim} ready to claim</strong>${arpBoostPart}</div>`,
    );
  }
  if (options.showClaimAll === true) {
    const skipArp =
      options.shouldSkipArpBoosts === true ? ' data-skip-arp="1"' : '';
    lines.push(
      `<div class="ao-note-actions"><button type="button" class="ao-claim-btn"${skipArp}>Claim all</button></div>`,
    );
  }
  lines.push(`<div>${renderTextLink('Open Battle Pass', bp.url)}</div>`);
  return `<div class="ao-note">${lines.join('')}</div>`;
}

export function renderCooldownBlock(
  settings: ArtifactOptimizerSettings,
  slotLocks?: Partial<Record<1 | 2 | 3, boolean>>,
): string {
  // Only show slots the Showroom currently marks locked. GM timers alone are
  // not enough — that was painting 22h leftovers after slots had unlocked.
  if (!slotLocks) {
    return '';
  }
  const lockedSlots = ([1, 2, 3] as const).filter(
    (position) => slotLocks[position] === true,
  );
  if (lockedSlots.length === 0) {
    return '';
  }
  const lockParts = formatLockedSlotParts(settings, lockedSlots, slotLocks);
  return `<div class="ao-note">24h slot cooldown: ${lockParts.join(', ')}</div>`;
}

function renderArpLogCard(siteState: SiteState | undefined): string {
  const arp = siteState?.arpLog;
  if (!arp) {
    return '';
  }
  const when = new Date(arp.scrapedAt).toLocaleString();
  const redeemable = arp.redeemableArp?.toLocaleString() ?? '?';
  const today =
    arp.todayDelta === undefined
      ? ''
      : `<div>Today so far: <strong>+${arp.todayDelta}</strong> ARP</div>`;
  const recent = arp.recent
    .slice(0, 5)
    .map(
      (entry) =>
        `<div class="ao-muted">${escapeHtml(entry.action)} · ${entry.arp}</div>`,
    )
    .join('');
  return `<div class="ao-note">
      <div><strong>ARP Log</strong> · scraped ${escapeHtml(when)}</div>
      <div>Redeemable: <strong>${redeemable}</strong></div>
      ${today}
      ${recent ? `<div style="margin-top:6px">Recent:</div>${recent}` : ''}
    </div>`;
}

function renderActivityCapsCard(siteState: SiteState | undefined): string {
  if (!siteState) {
    return '';
  }
  const caps = siteState.caps;
  const rows = (Object.keys(ACTIVITY_LABELS) as ActivityKey[])
    .map((key) => {
      const status = caps[key];
      if (!status || status === 'unknown') {
        return '';
      }
      const label = ACTIVITY_LABELS[key] ?? key;
      const word = status === 'available' ? 'available' : 'done / capped';
      const tone = status === 'available' ? '' : ' ao-muted';
      return `<div class="${tone.trim()}">${escapeHtml(label)} · ${word}</div>`;
    })
    .filter(Boolean);
  if (rows.length === 0) {
    return '';
  }
  const updated = siteState.updatedAt
    ? ` · ${escapeHtml(new Date(siteState.updatedAt).toLocaleString())}`
    : '';
  return `<div class="ao-note">
      <div><strong>Activity caps</strong>${updated}</div>
      ${rows.join('')}
    </div>`;
}

export function renderStatusSection(
  settings: ArtifactOptimizerSettings,
  siteState: SiteState | undefined,
  slotLocks?: Partial<Record<1 | 2 | 3, boolean>>,
  options: {
    showBattlePassClaimAll?: boolean;
    shouldSkipArpBoosts?: boolean;
  } = {},
): string {
  const cards = [
    renderBattlePassBlock(siteState, {
      showClaimAll: options.showBattlePassClaimAll === true,
      shouldSkipArpBoosts: options.shouldSkipArpBoosts === true,
    }),
    renderCommunityEventBlock(siteState, { detailed: true }),
    renderCooldownBlock(settings, slotLocks),
    renderActivityCapsCard(siteState),
    renderArpLogCard(siteState),
  ].filter(Boolean);
  if (cards.length === 0) {
    return '';
  }
  return `
    <div class="ao-heading">Status</div>
    ${cards.join('')}
  `;
}

export function formatSwapMessage(result: OptimizerResult): string {
  if (result.dailySwap) {
    return `<div class="ao-row">${escapeHtml(result.dailySwap.reason)}</div>`;
  }
  const currentIds = new Set(
    (result.current?.artifacts ?? []).map((a) => a.instanceId),
  );
  const bestIds = new Set(
    (result.best?.artifacts ?? []).map((a) => a.instanceId),
  );
  const isMatch =
    bestIds.size > 0 &&
    bestIds.size === currentIds.size &&
    [...bestIds].every((id) => currentIds.has(id));
  if (isMatch) {
    return `<div class="ao-row ao-muted">Current loadout matches the recommendation.</div>`;
  }
  if ((result.current?.artifacts.length ?? 0) < 3) {
    return `<div class="ao-row ao-muted">Equipped slots are incomplete (${result.current?.artifacts.length ?? 0}/3) — use Equip Recommended to fill empty slots.</div>`;
  }
  return `<div class="ao-row ao-muted">Could not compute a single-piece swap — use Equip Recommended.</div>`;
}

export function renderUpgradePath(
  upgrades: UpgradeSuggestion[],
  fragments: number,
): string {
  if (upgrades.length === 0) {
    return `<div class="ao-row ao-muted">No ARP upgrades left on owned artifacts.</div>`;
  }
  const seenAffordable = new Set<number>();
  let hasReachedSave = false;
  return upgrades
    .map((upgrade) => {
      const step = `${TIER_LABELS[upgrade.fromTier]} → ${TIER_LABELS[upgrade.toTier]}`;
      const gain = `+${upgrade.arpGain} ARP/mo`;
      if (upgrade.isAffordable) {
        const shouldShowUpgradeButton = !seenAffordable.has(
          upgrade.artifact.instanceId,
        );
        seenAffordable.add(upgrade.artifact.instanceId);
        const verb = shouldShowUpgradeButton ? 'Upgrade' : 'Then';
        const button = shouldShowUpgradeButton
          ? `<button type="button" class="ao-upgrade-btn" data-id="${upgrade.artifact.instanceId}">Upgrade</button>`
          : '';
        return `
        <div class="ao-row">
          ${verb} <strong>${upgrade.artifact.displayName}</strong>
          ${step}
          (${upgrade.fragmentCost} frag, ${gain}, ${upgrade.efficiency.toFixed(1)} ARP/frag)
          ${button}
        </div>`;
      }
      if (!hasReachedSave) {
        hasReachedSave = true;
        return `
        <div class="ao-row ao-muted">
          Save for <strong>${upgrade.artifact.displayName}</strong>
          ${step}
          (need ${upgrade.fragmentCost}, have ${fragments}, ${gain})
        </div>`;
      }
      return `
        <div class="ao-row ao-muted">
          Then <strong>${upgrade.artifact.displayName}</strong>
          ${step}
          (${upgrade.fragmentCost} frag, ${gain})
        </div>`;
    })
    .join('');
}

export function renderResultBody(
  result: OptimizerResult,
  snapshot: ArtifactSnapshot | undefined,
  settings: ArtifactOptimizerSettings,
  siteState: SiteState | undefined,
  options: { isHydrating?: boolean } = {},
): string {
  const scrapedAt = snapshot?.scrapedAt
    ? new Date(snapshot.scrapedAt).toLocaleString()
    : 'never';
  const fragments = settings.manualFragments ?? snapshot?.fragments ?? 0;
  const hydrateBanner = options.isHydrating
    ? renderHydrateBanner('Updating in the background…')
    : '';

  const actionPlan = renderActionPlan(
    buildActionPlan(result, settings, siteState ?? emptySiteState()),
  );
  const extras = supplementalNotes(result.notes)
    .map((n) => `<div class="ao-note">${escapeHtml(n)}</div>`)
    .join('');
  const vaultDiscount = renderVaultDiscountBlock(result);

  const upgrades = renderUpgradePath(result.upgrades, fragments);

  const swap = formatSwapMessage(result);
  const status = renderStatusSection(
    settings,
    siteState,
    snapshot?.slotLocks,
    {
      showBattlePassClaimAll: shouldShowBattlePassClaimAll(
        siteState?.battlePass,
        result.deferBattlePassClaims === true,
      ),
      shouldSkipArpBoosts: shouldSkipArpInBattlePassClaimAll(
        siteState?.battlePass,
        result.deferBattlePassClaims === true,
      ),
    },
  );
  const equippedLabel = formatEquippedLabel(result);

  const activityToggles = (
    Object.keys(settings.activities) as (keyof typeof settings.activities)[]
  )
    .map((key) => {
      const a = settings.activities[key];
      const label = ACTIVITY_LABELS[key] ?? key;
      return `
        <label class="ao-toggle">
          <input type="checkbox" data-activity="${key}" ${a.enabled ? 'checked' : ''}/>
          ${label} <span class="ao-muted">(freq)</span>
          <input type="number" min="0" max="2" step="0.1" data-freq="${key}" value="${a.frequency}"/>
        </label>`;
    })
    .join('');

  return `
    ${hydrateBanner}
    <div class="ao-muted">Inventory snapshot: ${scrapedAt} · Fragments: ${fragments}</div>
    ${actionPlan}
    ${vaultDiscount}
    ${extras}
    ${renderSectionDivider()}
    <div class="ao-heading">Recommended loadout</div>
    <div class="ao-row"><strong>${comboLabel(result.best)}</strong></div>
    ${renderBreakdown(result.best)}
    <div class="ao-heading">Currently equipped</div>
    <div class="ao-row">${equippedLabel}</div>
    ${result.current ? renderBreakdown(result.current) : ''}
    <div class="ao-heading">Suggested swap</div>
    ${swap}
    <div class="ao-heading">Upgrade priority</div>
    ${upgrades}
    ${status}
    <details class="ao-advanced">
      <summary>Advanced / manual overrides</summary>
      <div class="ao-heading">Activity profile</div>
      ${renderVaultDiscountRestore(result)}
      ${activityToggles}
      <div class="ao-row">
        Target Game Vault purchase (ARP):
        <input type="number" id="ao-vault-price" min="0" step="1" value="${settings.pendingVaultPurchaseArp}"/>
      </div>
      <div class="ao-row">
        Manual fragment override (blank = scraped):
        <input type="number" id="ao-manual-frags" min="0" step="1" value="${
          settings.manualFragments ?? ''
        }" placeholder="auto"/>
      </div>
      <div class="ao-heading">Manual artifacts</div>
      <div class="ao-muted">Only needed if auto-scrape fails.</div>
      <div class="ao-row">
        <select id="ao-manual-family">
          ${ARTIFACTS.map((a) => `<option value="${a.id}">${a.id}</option>`).join('')}
        </select>
        <select id="ao-manual-tier">
          ${Object.entries(TIER_LABELS)
            .map(([k, v]) => `<option value="${k}">${v}</option>`)
            .join('')}
        </select>
        <button type="button" id="ao-add-manual">Add</button>
      </div>
      <div id="ao-manual-list" class="ao-row">
        ${
          settings.manualArtifacts.length === 0
            ? '<span class="ao-muted">None</span>'
            : settings.manualArtifacts
                .map(
                  (m, index) =>
                    `<div>${m.familyId} @ ${TIER_LABELS[m.tier]}
                      <button type="button" class="ao-remove-manual ao-secondary" data-index="${index}">Remove</button>
                     </div>`,
                )
                .join('')
        }
      </div>
    </details>
  `;
}
