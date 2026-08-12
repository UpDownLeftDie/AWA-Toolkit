import { applyAsceCommunityHours } from '../asce';
import type { OptimizerResult } from '../optimizer';
import { isArtifactsShowroomPage, waitForShowroomDocument } from '../scraper';
import {
  refreshSiteStateFromPage,
  saveSiteState,
  waitForControlCenterDocument,
  watchArpLogPage,
  watchBattlePassPage,
  watchControlCenterPage,
} from '../siteState';
import { buildActionPlan, renderActionPlan } from './actionPlan';
import {
  bindDynamicBody,
  bindUpgradeButtons,
  confirmAndApplyCombo,
  confirmAndApplyLoadout,
  persistFormSettings,
} from './actions';
import { showAoToast } from './dialog';
import {
  gatheredCache,
  gatherData,
  hydrateGatheredData,
  isControlCenterPage,
  isSiteStatePage,
  requiresBackgroundHydrate,
  type GatheredData,
} from './gather';
import { comboLabel, escapeHtml } from './loadoutPlan';
import {
  bindVaultDiscountActions,
  renderBreakdown,
  renderCooldownBlock,
  renderCredits,
  renderHydrateBanner,
  renderModalSkeleton,
  renderPanelSkeleton,
  renderResultBody,
  renderSectionDivider,
  renderVaultDiscountBlock,
  supplementalNotes,
} from './render';
import {
  BACKDROP_ID,
  CC_PANEL_ID,
  INLINE_ID,
  MODAL_ID,
  applyOpaqueBackdropChrome,
  applyOpaqueModalChrome,
  buildInlineShadowCss,
  buildModalShadowCss,
  ensureOptimizerStyles,
} from './styles';

function ensureOptimizerBackdrop(): HTMLElement {
  let backdrop = document.querySelector<HTMLElement>(`#${BACKDROP_ID}`);
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID;
    backdrop.style.setProperty('display', 'none', 'important');
    applyOpaqueBackdropChrome(backdrop);
    backdrop.addEventListener('click', () => {
      setOptimizerModalOpen(false);
    });
    document.body.append(backdrop);
  }
  return backdrop;
}

function setOptimizerModalOpen(isOpen: boolean): void {
  const modal = document.querySelector<HTMLElement>(`#${MODAL_ID}`);
  const backdrop = ensureOptimizerBackdrop();
  if (!modal) {
    backdrop.style.setProperty('display', 'none', 'important');
    return;
  }
  modal.hidden = !isOpen;
  if (isOpen) {
    applyOpaqueModalChrome(modal);
    applyOpaqueBackdropChrome(backdrop);
    modal.style.setProperty('display', 'block', 'important');
    backdrop.style.setProperty('display', 'block', 'important');
  } else {
    modal.style.setProperty('display', 'none', 'important');
    backdrop.style.setProperty('display', 'none', 'important');
  }
}

type RefreshViewOptions = {
  remote?: boolean;
  /**
  Re-read the live page and await ASCE. Does not write Advanced settings —
  Save does that. On Control Center, skips a forced remote event-page fetch.
  */
  force?: boolean;
  /**
  Write Advanced form fields to GM before gathering (Save only).
  */
  persist?: boolean;
};

type OptimizerModal = HTMLElement & {
  __aoRefresh?: (options?: RefreshViewOptions) => Promise<void>;
};

function panelTree(root: HTMLElement): ParentNode {
  return root.shadowRoot ?? root;
}

function modalTree(modal: HTMLElement): ParentNode {
  return panelTree(modal);
}

/**
Prefer a non-link insertion point so site link styles cannot leak in.
*/
function resolveShowroomInsertTarget():
  | {
      parent: Element;
      before: ChildNode | null;
    }
  | undefined {
  const fragments = [...document.querySelectorAll('div, p, span')].find(
    (element) => /^Fragments:\s*\d+/i.test(element.textContent?.trim() ?? ''),
  );
  let target: Element | undefined =
    fragments ?? document.querySelector('#weapon-section') ?? undefined;
  if (!target) {
    return undefined;
  }
  const link = target.closest('a');
  if (link) {
    target = link;
  }
  const parent = target.parentElement;
  if (!parent) {
    return undefined;
  }
  return { parent, before: target.nextSibling };
}

function bindModalEvents(
  modal: OptimizerModal,
  initial: Awaited<ReturnType<typeof gatherData>>,
): void {
  let cache = initial;
  const tree = (): ParentNode => modalTree(modal);

  const paint = (
    data: Awaited<ReturnType<typeof gatherData>>,
    options: { isHydrating?: boolean } = {},
  ): void => {
    cache = data;
    const body = tree().querySelector('#ao-body');
    if (!body) {
      return;
    }
    body.innerHTML = renderResultBody(
      cache.result,
      cache.snapshot,
      cache.settings,
      cache.siteState,
      { isHydrating: options.isHydrating === true },
    );
    bindDynamicBody(body as HTMLElement, () => refreshView());
  };

  const refreshView = async (options?: RefreshViewOptions): Promise<void> => {
    const isRemote = options?.remote ?? true;
    const isForce = options?.force ?? false;
    if (options?.persist === true) {
      await persistFormSettings(tree());
    }
    const cached = await gatherData({ remote: false });
    const shouldHydrate =
      isRemote &&
      (isForce || requiresBackgroundHydrate(cached, { force: isForce }));
    paint(cached, { isHydrating: shouldHydrate });
    if (!shouldHydrate) {
      return;
    }
    paint(await hydrateGatheredData({ force: isForce }), {
      isHydrating: false,
    });
    syncControlCenterFromGathered();
  };

  tree()
    .querySelector('#ao-close')
    ?.addEventListener('click', () => {
      setOptimizerModalOpen(false);
    });

  tree()
    .querySelector('#ao-save')
    ?.addEventListener('click', () => {
      void (async () => {
        await persistFormSettings(tree());
        await refreshView({ persist: false });
        showAoToast('Settings saved.');
      })();
    });

  tree()
    .querySelector('#ao-equip')
    ?.addEventListener('click', () => {
      void confirmAndApplyLoadout(cache.result, cache.settings);
    });

  tree()
    .querySelector('#ao-refresh')
    ?.addEventListener('click', () => {
      void refreshView({ force: true });
    });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) {
      setOptimizerModalOpen(false);
    }
  });

  paint(initial, {
    isHydrating: requiresBackgroundHydrate(initial),
  });
  modal.__aoRefresh = refreshView;
}

/**
 * Drop any leftover dialog from older script versions (light DOM without shadow).
 */
function destroyOptimizerModal(): void {
  document.querySelector(`#${MODAL_ID}`)?.remove();
  document.querySelector(`#${BACKDROP_ID}`)?.remove();
}

/**
 * Prepare styles only. The dialog DOM is created the first time it is opened
 * so a failed stylesheet can never leave a visible overlay on page load.
 */
export async function createOptimizerModal(): Promise<void> {
  destroyOptimizerModal();
  ensureOptimizerStyles();
}

async function openOptimizerModal(): Promise<void> {
  ensureOptimizerStyles();
  let modal =
    document.querySelector<OptimizerModal>(`#${MODAL_ID}`) ?? undefined;
  // Recreate if this is a stale pre-shadow modal from a hot-updated userscript.
  if (modal && !modal.shadowRoot) {
    modal.remove();
    modal = undefined;
  }
  const isNew = !modal;
  if (!modal) {
    const shell = document.createElement('div') as OptimizerModal;
    shell.id = MODAL_ID;
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-labelledby', 'ao-title');
    shell.hidden = true;
    const shadow = shell.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${buildModalShadowCss()}</style>
      <div class="ao-panel">
        <div class="ao-title" id="ao-title">Artifact Optimizer</div>
        ${renderCredits()}
        <div id="ao-body">
          ${renderModalSkeleton()}
        </div>
        <div class="ao-actions">
          <button type="button" id="ao-equip">Equip Recommended</button>
          <button type="button" id="ao-refresh" class="ao-secondary">Refresh</button>
          <button type="button" id="ao-save" class="ao-secondary">Save Settings</button>
          <button type="button" id="ao-close" class="ao-danger">Close</button>
        </div>
      </div>
    `;
    document.body.append(shell);
    modal = shell;
  }

  setOptimizerModalOpen(true);
  if (isNew) {
    const cached =
      gatheredCache.current ?? (await gatherData({ remote: false }));
    bindModalEvents(modal, cached);
  }
  const shouldHydrate =
    gatheredCache.current !== undefined &&
    requiresBackgroundHydrate(gatheredCache.current);
  if (shouldHydrate || !isNew) {
    void modal.__aoRefresh?.({ remote: shouldHydrate || !isNew });
  }
}

export function addOptimizerMenuButton(): void {
  const menuList = document.querySelector<HTMLElement>(
    '.nav-item-mus .dropdown-menu.dropdown-menu-end',
  );
  if (!menuList || menuList.querySelector('[data-ao-menu]')) {
    return;
  }
  const item = document.createElement('a');
  item.className = 'dropdown-item';
  item.href = '#';
  item.dataset.aoMenu = '1';
  item.textContent = 'Artifact Optimizer';
  item.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openOptimizerModal();
  });
  menuList.insertBefore(item, menuList.lastElementChild);
}

function watchOptimizerMenuButton(): void {
  addOptimizerMenuButton();
  if (document.documentElement.dataset.aoMenuWatch === '1') {
    return;
  }
  document.documentElement.dataset.aoMenuWatch = '1';
  const observer = new MutationObserver(() => {
    if (!document.querySelector('[data-ao-menu]')) {
      addOptimizerMenuButton();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function parkElement(element: HTMLElement): void {
  const parent = document.body ?? document.documentElement;
  if (element.parentElement !== parent) {
    parent.prepend(element);
  }
}

function findControlCenterMount(): HTMLElement | undefined {
  return (
    document.querySelector<HTMLElement>('.container.account.has-fixed-menu') ??
    document.querySelector<HTMLElement>('main .container.account') ??
    document.querySelector<HTMLElement>('main') ??
    undefined
  );
}

function insertControlCenterHost(panel: HTMLElement): void {
  const container = findControlCenterMount();
  if (container) {
    if (panel.parentElement !== container) {
      container.prepend(panel);
    }
    return;
  }
  parkElement(panel);
}

function watchControlCenterHost(panel: HTMLElement): void {
  insertControlCenterHost(panel);
  if (panel.dataset.aoHostWatch === '1') {
    return;
  }
  panel.dataset.aoHostWatch = '1';
  const observer = new MutationObserver(() => {
    if (!panel.isConnected) {
      insertControlCenterHost(panel);
      return;
    }
    const mount = findControlCenterMount();
    if (mount && panel.parentElement !== mount && !panel.contains(mount)) {
      insertControlCenterHost(panel);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function insertShowroomHost(panel: HTMLElement): void {
  const insert = resolveShowroomInsertTarget();
  if (!insert) {
    parkElement(panel);
    return;
  }
  if (panel.parentNode !== insert.parent) {
    insert.parent.insertBefore(panel, insert.before);
  }
}

function watchShowroomHost(panel: HTMLElement): void {
  insertShowroomHost(panel);
  if (panel.dataset.aoHostWatch === '1') {
    return;
  }
  panel.dataset.aoHostWatch = '1';
  const observer = new MutationObserver(() => {
    if (!panel.isConnected) {
      insertShowroomHost(panel);
      return;
    }
    const parent = panel.parentElement;
    const isParked =
      parent === document.body || parent === document.documentElement;
    if (isParked) {
      insertShowroomHost(panel);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function mountInlinePanelShadow(
  host: HTMLElement,
  bodyHtml: string,
): ShadowRoot {
  // Recreate if this is a stale pre-shadow panel from a hot-updated userscript.
  if (host.shadowRoot) {
    host.shadowRoot.replaceChildren();
  }
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${buildInlineShadowCss()}</style>
    <div class="ao-panel">
      ${bodyHtml}
    </div>
  `;
  return shadow;
}

function replaceInlinePanelBody(panel: HTMLElement, bodyHtml: string): void {
  const box = panelTree(panel).querySelector('.ao-panel');
  if (box) {
    box.innerHTML = bodyHtml;
    return;
  }
  mountInlinePanelShadow(panel, bodyHtml);
}

function bumpPanelGeneration(panel: HTMLElement): number {
  const generation = Number(panel.dataset.aoGen ?? '0') + 1;
  panel.dataset.aoGen = String(generation);
  return generation;
}

function isPanelGenerationCurrent(
  panel: HTMLElement,
  generation: number,
): boolean {
  return panel.isConnected && panel.dataset.aoGen === String(generation);
}

function renderShowroomPanelBody(
  data: GatheredData,
  options: { isHydrating?: boolean } = {},
): string {
  const hydrateBanner = options.isHydrating
    ? renderHydrateBanner('Updating in the background…')
    : '';
  return `
    <div class="ao-heading">Artifact Optimizer</div>
    ${renderCredits({ compact: true })}
    ${hydrateBanner}
    <div class="ao-row"><strong>Recommended:</strong> ${comboLabel(data.result.best)}</div>
    ${renderBreakdown(data.result.best)}
    ${renderVaultDiscountBlock(data.result)}
    ${renderShowroomEquipActions(data.result)}
  `;
}

function renderControlCenterPanelBody(
  data: GatheredData,
  options: { isHydrating?: boolean } = {},
): string {
  const hydrateBanner = options.isHydrating
    ? renderHydrateBanner('Updating in the background…')
    : '';
  return `
    <div class="ao-heading">Artifact Optimizer</div>
    ${renderCredits({ compact: true })}
    ${hydrateBanner}
    ${renderActionPlan(
      buildActionPlan(data.result, data.settings, data.siteState),
    )}
    ${renderSectionDivider()}
    <div class="ao-row"><strong>Recommended:</strong> ${comboLabel(data.result.best)}</div>
    ${renderBreakdown(data.result.best)}
    ${renderCooldownBlock(data.settings, data.snapshot?.slotLocks)}
    ${renderVaultDiscountBlock(data.result)}
    ${supplementalNotes(data.result.notes)
      .map((note) => `<div class="ao-note">${escapeHtml(note)}</div>`)
      .join('')}
    <div class="ao-actions">
      <button type="button" id="ao-cc-equip">Equip Recommended</button>
      <button type="button" id="ao-cc-open" class="ao-secondary">Open Full Panel</button>
      <button type="button" id="ao-cc-artifacts" class="ao-secondary">Go to Artifacts</button>
      <button type="button" id="ao-cc-refresh" class="ao-secondary">Refresh</button>
    </div>
  `;
}

function ensureControlCenterHost(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`#${CC_PANEL_ID}`);
  if (existing) {
    watchControlCenterHost(existing);
    return existing;
  }
  const panel = document.createElement('div');
  panel.id = CC_PANEL_ID;
  mountInlinePanelShadow(panel, renderPanelSkeleton());
  watchControlCenterHost(panel);
  return panel;
}

function ensureShowroomHost(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`#${INLINE_ID}`);
  if (existing) {
    watchShowroomHost(existing);
    return existing;
  }
  const panel = document.createElement('div');
  panel.id = INLINE_ID;
  mountInlinePanelShadow(panel, renderPanelSkeleton());
  watchShowroomHost(panel);
  return panel;
}

async function refreshPanelFromLivePage(
  panel: HTMLElement,
  generation: number,
  paint: (data: GatheredData, isHydrating: boolean) => void,
): Promise<void> {
  if (isControlCenterPage()) {
    await waitForControlCenterDocument();
    if (!isPanelGenerationCurrent(panel, generation)) {
      return;
    }
    insertControlCenterHost(panel);
  } else if (isArtifactsShowroomPage()) {
    await waitForShowroomDocument();
    if (!isPanelGenerationCurrent(panel, generation)) {
      return;
    }
    insertShowroomHost(panel);
  } else {
    return;
  }
  const live = await gatherData({ remote: false });
  if (!isPanelGenerationCurrent(panel, generation)) {
    return;
  }
  paint(live, false);
}

async function fillPanelFromCacheThenHydrate(
  panel: HTMLElement,
  generation: number,
  paint: (data: GatheredData, isHydrating: boolean) => void,
  options: { force?: boolean } = {},
): Promise<void> {
  const isForce = options.force === true;

  // Force Refresh: skip the stale cache paint so lock icons from Showroom
  // replace GM leftovers in one shot.
  if (isForce) {
    const cached =
      gatheredCache.current ?? (await gatherData({ remote: false }));
    if (!isPanelGenerationCurrent(panel, generation)) {
      return;
    }
    paint(cached, true);
    const hydrated = await hydrateGatheredData({ force: true });
    if (!isPanelGenerationCurrent(panel, generation)) {
      return;
    }
    paint(hydrated, false);
    return;
  }

  const cached = await gatherData({ remote: false });
  if (!isPanelGenerationCurrent(panel, generation)) {
    return;
  }
  const shouldHydrate = requiresBackgroundHydrate(cached, options);
  paint(cached, shouldHydrate);

  if (!shouldHydrate) {
    await refreshPanelFromLivePage(panel, generation, (data, isHydrating) => {
      paint(data, isHydrating);
    });
    return;
  }
  const hydrated = await hydrateGatheredData(options);
  if (!isPanelGenerationCurrent(panel, generation)) {
    return;
  }
  paint(hydrated, false);
}

function renderShowroomEquipActions(result: OptimizerResult): string {
  const allArp = result.allArpLoadout
    ? `<button type="button" id="ao-inline-equip-allarp" title="${escapeHtml(comboLabel(result.allArpLoadout))}">Equip All-ARP%</button>`
    : '';
  const monthlyMeta = result.monthlyMetaLoadout
    ? `<button type="button" id="ao-inline-equip-monthly" class="ao-secondary" title="${escapeHtml(comboLabel(result.monthlyMetaLoadout))}">Equip Monthly META</button>`
    : '';
  const market = result.marketDiscountLoadout
    ? `<button type="button" id="ao-inline-equip-market" class="ao-secondary" title="${escapeHtml(comboLabel(result.marketDiscountLoadout))}">Equip Market Discount</button>`
    : '';
  return `
    <div class="ao-actions">
      <button type="button" id="ao-inline-equip">Equip Recommended</button>
      ${allArp}
      ${monthlyMeta}
      ${market}
      <button type="button" id="ao-inline-open" class="ao-secondary">Open Full Panel</button>
    </div>
  `;
}

export async function injectShowroomPanel(
  options: { force?: boolean } = {},
): Promise<void> {
  if (!isArtifactsShowroomPage()) {
    return;
  }
  ensureOptimizerStyles();
  const panel = ensureShowroomHost();
  if (panel.dataset.aoReady === '1' && options.force !== true) {
    return;
  }
  const generation = bumpPanelGeneration(panel);

  const paint = (data: GatheredData, isHydrating: boolean): void => {
    replaceInlinePanelBody(
      panel,
      renderShowroomPanelBody(data, { isHydrating }),
    );
    bindShowroomPanelActions(panel, data);
    bindVaultDiscountActions(panelTree(panel), () => {
      void injectShowroomPanel({ force: true });
    });
  };

  await fillPanelFromCacheThenHydrate(panel, generation, paint, options);
  if (isPanelGenerationCurrent(panel, generation)) {
    panel.dataset.aoReady = '1';
  }
}

function paintControlCenterPanel(
  panel: HTMLElement,
  data: GatheredData,
  isHydrating: boolean,
): void {
  replaceInlinePanelBody(
    panel,
    renderControlCenterPanelBody(data, { isHydrating }),
  );
  bindInlinePanelActions(panel, data, {
    equipId: 'ao-cc-equip',
    openId: 'ao-cc-open',
  });
  // No-op: handleUpgradeClick already force-reinjects this same panel after
  // onChanged resolves, so refreshing it here too would just double-fetch.
  bindUpgradeButtons(panelTree(panel), async () => {});
  bindVaultDiscountActions(panelTree(panel), () => {
    void injectControlCenterPanel({ force: true });
  });
  panelTree(panel)
    .querySelector('#ao-cc-artifacts')
    ?.addEventListener('click', () => {
      location.assign('/user-artifacts-room');
    });
  panelTree(panel)
    .querySelector('#ao-cc-refresh')
    ?.addEventListener('click', () => {
      void injectControlCenterPanel({ force: true });
    });
}

function syncControlCenterFromGathered(): void {
  if (!isControlCenterPage() || !gatheredCache.current) {
    return;
  }
  const panel = document.querySelector<HTMLElement>(`#${CC_PANEL_ID}`);
  if (!panel?.shadowRoot) {
    return;
  }
  paintControlCenterPanel(panel, gatheredCache.current, false);
}

export async function injectControlCenterPanel(
  options: { force?: boolean } = {},
): Promise<void> {
  if (!isControlCenterPage()) {
    return;
  }
  ensureOptimizerStyles();
  const panel = ensureControlCenterHost();
  if (panel.dataset.aoReady === '1' && options.force !== true) {
    return;
  }
  const generation = bumpPanelGeneration(panel);

  const paint = (data: GatheredData, isHydrating: boolean): void => {
    paintControlCenterPanel(panel, data, isHydrating);
  };

  await fillPanelFromCacheThenHydrate(panel, generation, paint, options);
  if (isPanelGenerationCurrent(panel, generation)) {
    panel.dataset.aoReady = '1';
  }
}

const DEFAULT_INLINE_PANEL_IDS = {
  equipId: 'ao-inline-equip',
  openId: 'ao-inline-open',
} as const;

function bindShowroomPanelActions(
  panel: HTMLElement,
  data: Awaited<ReturnType<typeof gatherData>>,
): void {
  const tree = panelTree(panel);
  tree.querySelector('#ao-inline-equip')?.addEventListener('click', () => {
    void confirmAndApplyCombo(
      data.result.best,
      data.result.current,
      data.settings,
      'recommended',
    );
  });
  tree
    .querySelector('#ao-inline-equip-allarp')
    ?.addEventListener('click', () => {
      void confirmAndApplyCombo(
        data.result.allArpLoadout,
        data.result.current,
        data.settings,
        'All-ARP%',
      );
    });
  tree
    .querySelector('#ao-inline-equip-monthly')
    ?.addEventListener('click', () => {
      void confirmAndApplyCombo(
        data.result.monthlyMetaLoadout,
        data.result.current,
        data.settings,
        'monthly META',
      );
    });
  tree
    .querySelector('#ao-inline-equip-market')
    ?.addEventListener('click', () => {
      void confirmAndApplyCombo(
        data.result.marketDiscountLoadout,
        data.result.current,
        data.settings,
        'market discount',
      );
    });
  tree.querySelector('#ao-inline-open')?.addEventListener('click', () => {
    void openOptimizerModal();
  });
}

function bindInlinePanelActions(
  panel: HTMLElement,
  data: Awaited<ReturnType<typeof gatherData>>,
  ids: {
    equipId: string;
    openId: string;
  } = DEFAULT_INLINE_PANEL_IDS,
): void {
  const tree = panelTree(panel);
  tree.querySelector(`#${ids.equipId}`)?.addEventListener('click', () => {
    void confirmAndApplyLoadout(data.result, data.settings);
  });
  tree.querySelector(`#${ids.openId}`)?.addEventListener('click', () => {
    void openOptimizerModal();
  });
}

export async function initArtifactOptimizer(): Promise<void> {
  ensureOptimizerStyles();
  watchOptimizerMenuButton();

  if (isControlCenterPage()) {
    ensureControlCenterHost();
    void injectControlCenterPanel();
    watchControlCenterPage(async (state) => {
      await applyAsceCommunityHours(state);
      await saveSiteState(state);
      const panel = document.querySelector<HTMLElement>(`#${CC_PANEL_ID}`);
      if (!panel?.shadowRoot) {
        return;
      }
      paintControlCenterPanel(
        panel,
        await gatherData({ remote: false }),
        false,
      );
    });
  } else if (isArtifactsShowroomPage()) {
    ensureShowroomHost();
    void injectShowroomPanel();
  } else if (isSiteStatePage()) {
    if (location.pathname.includes('/battle-pass')) {
      watchBattlePassPage(async (state) => {
        await applyAsceCommunityHours(state);
        await saveSiteState(state);
      });
    } else if (location.pathname.includes('/arp-log')) {
      watchArpLogPage(async (state) => {
        await applyAsceCommunityHours(state);
        await saveSiteState(state);
      });
    } else {
      void (async () => {
        const state = await refreshSiteStateFromPage();
        await applyAsceCommunityHours(state);
        await saveSiteState(state);
      })();
    }
  }

  await createOptimizerModal();
}
