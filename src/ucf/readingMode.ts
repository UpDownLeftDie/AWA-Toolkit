import { GM } from '$';

const READING_KEY = 'ucfReadingMode';
const TABLES_KEY = 'ucfClassicTables';
const STYLE_ID = 'awa-ucf-reading-mode-styles';
const BAR_ID = 'awa-ucf-reading-bar';
const JUMP_ID = 'awa-ucf-jump';
const ACTION_ID = 'awa-ucf-reading-action';
const READING_CLASS = 'awa-ucf-reading-mode';
const TABLES_CLASS = 'awa-ucf-classic-tables';
const RULE_ROW_CLASS = 'awa-ucf-table-rule';
const UCF_POST_PATH = /\/ucf\/show\//i;
const NAVBAR_OFFSET_PX = 80;
const NAVBAR_OFFSET = `${NAVBAR_OFFSET_PX}px`;
const STICKY_GAP_PX = 8;
const TABLE_SCOPE =
  ':is(.ucf__content, .discussion__op-content, .js-comments-post)';
const DATA_TABLE = 'table:has(:is(th + th, td + td))';
const HEADER_PAD = /[\u{00A0}\u{2007}\u{202F}\u{3000}]+/gu;

interface UcfLayoutState {
  isReading: boolean;
  isClassicTables: boolean;
}

function isUcfPostPage(): boolean {
  return UCF_POST_PATH.test(location.pathname);
}

function isFlag(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

async function isStoredFlag(key: string, isDefault: boolean): Promise<boolean> {
  const raw: unknown = await GM.getValue(key);
  if (raw === undefined || raw === null) {
    return isDefault;
  }
  if (isFlag(raw)) {
    return raw;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) === true;
    } catch {
      return isDefault;
    }
  }
  return isDefault;
}

async function loadLayoutState(): Promise<UcfLayoutState> {
  const [isReading, isClassicTables] = await Promise.all([
    isStoredFlag(READING_KEY, false),
    isStoredFlag(TABLES_KEY, true),
  ]);
  return { isReading, isClassicTables };
}

function layoutStateFromDom(): UcfLayoutState {
  return {
    isReading: document.documentElement.classList.contains(READING_CLASS),
    isClassicTables: document.documentElement.classList.contains(TABLES_CLASS),
  };
}

function buildReadingModeCss(): string {
  return `
    .forums__header:has(#${BAR_ID}) {
      min-height: 0 !important;
      height: auto !important;
      position: sticky;
      top: ${NAVBAR_OFFSET};
      z-index: 1020;
      background: #f7f8f8;
      border-bottom: 1px solid rgba(0, 0, 0, 0.08);
      padding: 0.45rem 0.25rem;
    }

    #${BAR_ID} {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 0.85rem 1.5rem;
      flex-wrap: wrap;
      width: 100%;
    }

    #${JUMP_ID} {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }

    .awa-ucf-jump__btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      margin: 0;
      padding: 0.28rem 0.65rem;
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 999px;
      background: #fff;
      color: #282829;
      font-weight: 600;
      font-size: 0.82rem;
      line-height: 1.2;
      cursor: pointer;
    }

    .awa-ucf-jump__btn:hover,
    .awa-ucf-jump__btn:focus-visible {
      border-color: #00bc8c;
      color: #0a7a5c;
      outline: none;
    }

    .awa-ucf-jump__btn:focus-visible {
      outline: 2px solid #00bc8c;
      outline-offset: 2px;
    }

    .awa-ucf-reading-toggle {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 0.7rem;
      margin: 0;
      cursor: pointer;
      user-select: none;
      color: #282829;
      font-weight: 600;
      font-size: 0.95rem;
      line-height: 1.2;
    }

    .awa-ucf-reading-toggle__input {
      position: absolute;
      inset: 0;
      opacity: 0;
      margin: 0;
      width: 100%;
      height: 100%;
      cursor: pointer;
    }

    .awa-ucf-reading-toggle__switch {
      position: relative;
      flex: 0 0 auto;
      width: 2.6rem;
      height: 1.45rem;
      border-radius: 999px;
      background: #c5c8cc;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
      transition: background-color 0.15s ease;
    }

    .awa-ucf-reading-toggle__switch::after {
      content: '';
      position: absolute;
      top: 0.15rem;
      left: 0.15rem;
      width: 1.15rem;
      height: 1.15rem;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
      transition: transform 0.15s ease;
    }

    .awa-ucf-reading-toggle:has(.awa-ucf-reading-toggle__input:focus-visible) .awa-ucf-reading-toggle__switch {
      outline: 2px solid #00bc8c;
      outline-offset: 2px;
    }

    .awa-ucf-reading-toggle:has(.awa-ucf-reading-toggle__input:checked) .awa-ucf-reading-toggle__switch {
      background: #00bc8c;
    }

    .awa-ucf-reading-toggle:has(.awa-ucf-reading-toggle__input:checked) .awa-ucf-reading-toggle__switch::after {
      transform: translateX(1.15rem);
    }

    .awa-ucf-reading-toggle__text {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }

    html.${READING_CLASS} .forums__header:has(#${BAR_ID}),
    html.${TABLES_CLASS} .forums__header:has(#${BAR_ID}) {
      background: #e8f7f2;
      border-bottom-color: #00bc8c;
    }

    html.${READING_CLASS} .row.forums-layout > .col-12.col-lg-4 {
      display: none !important;
    }

    html.${READING_CLASS} .row.forums-layout > .col-12.col-lg-8 {
      flex: 0 0 100% !important;
      max-width: 100% !important;
      width: 100% !important;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row {
      flex-wrap: wrap;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 {
      flex: 0 0 100% !important;
      max-width: 100% !important;
      width: 100% !important;
      padding-top: 0.2rem;
      padding-bottom: 0;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-9.col-md-9 {
      flex: 0 0 100% !important;
      max-width: 100% !important;
      width: 100% !important;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-avatar-container {
      max-height: none !important;
      display: flex !important;
      flex-direction: row !important;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem 0.7rem;
      width: auto !important;
      max-width: 100%;
      padding: 0.1rem 0 !important;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-avatar-container > .row {
      margin: 0 !important;
      width: auto !important;
      flex: 0 0 auto;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-avatar-container > .row:has(.profile-subtitle.images) {
      order: -1;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 :is(.profile-username, .profile-subtitle) {
      text-align: left !important;
      padding: 0 !important;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-full-avatar {
      width: 2.5rem !important;
      height: 2.5rem !important;
      overflow: hidden;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-full-avatar :is(.user-avatar__layer, .user-avatar__sizer) {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      object-fit: cover;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-full-avatar .user-avatar__sizer {
      position: absolute !important;
      inset: 0;
    }

    html.${READING_CLASS} .ucf__content img[src*="user_badge"] {
      display: none;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} figure:has(${DATA_TABLE}) {
      overflow-x: auto;
      max-width: 100%;
      margin: 0.85rem 0;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} ${DATA_TABLE} {
      width: 100% !important;
      min-width: 36rem;
      border-collapse: collapse !important;
      background: #fff !important;
      color: #3a3a3a !important;
      border: 1px solid #5b9bd5 !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} ${DATA_TABLE} :is(th, td) {
      border: 1px solid #5b9bd5 !important;
      padding: 0.5rem 0.7rem !important;
      vertical-align: top !important;
      color: #3a3a3a !important;
      background: #fff !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} ${DATA_TABLE} th {
      color: #2e75b6 !important;
      text-align: center !important;
      font-weight: 700 !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} ${DATA_TABLE} th strong {
      color: inherit !important;
      font-weight: 700 !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} tr.${RULE_ROW_CLASS} {
      display: none !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} table:not(:has(:is(th + th, td + td))) {
      border: none !important;
      width: auto !important;
      min-width: 0 !important;
      background: transparent !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} table:not(:has(:is(th + th, td + td))) :is(th, td) {
      border: none !important;
      padding: 0.2rem 0 !important;
      background: transparent !important;
      color: inherit !important;
      text-align: inherit !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .awa-ucf-reading-toggle__switch,
      .awa-ucf-reading-toggle__switch::after {
        transition: none;
      }
    }
  `;
}

function ensureStyles(): void {
  let style = document.querySelector<HTMLStyleElement>(`#${STYLE_ID}`);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    (document.head || document.documentElement).append(style);
  }
  style.textContent = buildReadingModeCss();
}

function applyLayout(state: UcfLayoutState): void {
  document.documentElement.classList.toggle(READING_CLASS, state.isReading);
  document.documentElement.classList.toggle(
    TABLES_CLASS,
    state.isClassicTables,
  );
}

function expandIconClass(isEnabled: boolean, extraClass?: string): string {
  const name = isEnabled ? 'fa-compress' : 'fa-expand';
  return extraClass ? `fa ${name} ${extraClass}` : `fa ${name}`;
}

function syncToggleUi(state: UcfLayoutState): void {
  const readingInput = document.querySelector<HTMLInputElement>(
    `#${BAR_ID} [data-awa-ucf-toggle="reading"]`,
  );
  if (readingInput) {
    readingInput.checked = state.isReading;
  }

  const tablesInput = document.querySelector<HTMLInputElement>(
    `#${BAR_ID} [data-awa-ucf-toggle="tables"]`,
  );
  if (tablesInput) {
    tablesInput.checked = state.isClassicTables;
  }

  const readingIcon = document.querySelector(
    `#${BAR_ID} [data-awa-ucf-icon="reading"]`,
  );
  if (readingIcon) {
    readingIcon.className = expandIconClass(
      state.isReading,
      'awa-ucf-reading-toggle__icon',
    );
  }

  const action = document.querySelector<HTMLButtonElement>(`#${ACTION_ID}`);
  if (action) {
    action.setAttribute('aria-pressed', state.isReading ? 'true' : 'false');
    const actionIcon = action.querySelector('i');
    if (actionIcon) {
      actionIcon.className = expandIconClass(state.isReading);
    }
    const actionLabel = action.querySelector('.awa-ucf-reading-action-label');
    if (actionLabel) {
      actionLabel.textContent = state.isReading
        ? 'Exit reading mode'
        : 'Reading mode';
    }
  }
}

async function persistLayout(state: UcfLayoutState): Promise<void> {
  await Promise.all([
    GM.setValue(READING_KEY, state.isReading),
    GM.setValue(TABLES_KEY, state.isClassicTables),
  ]);
}

async function setLayout(patch: Partial<UcfLayoutState>): Promise<void> {
  const next = { ...layoutStateFromDom(), ...patch };
  applyLayout(next);
  syncToggleUi(next);
  if (next.isClassicTables) {
    prepareTables();
  }
  await persistLayout(next);
}

function normalizeHeaderText(cell: HTMLElement): void {
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      node.textContent = node.textContent
        .replaceAll(HEADER_PAD, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim();
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      for (const child of node.childNodes) {
        walk(child);
      }
    }
  };
  walk(cell);
}

function isRuleRow(row: HTMLTableRowElement): boolean {
  const text = (row.textContent ?? '').replaceAll(/\s+/g, '');
  return text.length > 0 && !/\p{L}|\p{N}/u.test(text);
}

function prepareTables(): void {
  const rows = document.querySelectorAll<HTMLTableRowElement>(
    `${TABLE_SCOPE} tr`,
  );
  for (const row of rows) {
    row.classList.toggle(RULE_ROW_CLASS, isRuleRow(row));
  }

  const headers = document.querySelectorAll<HTMLElement>(`${TABLE_SCOPE} th`);
  for (const header of headers) {
    if (header.dataset.awaUcfHeader === '1') {
      continue;
    }
    normalizeHeaderText(header);
    header.dataset.awaUcfHeader = '1';
  }
}

function createIcon(className: string): HTMLElement {
  const icon = document.createElement('i');
  icon.className = className;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function buildSwitch(options: {
  toggle: 'reading' | 'tables';
  label: string;
  title: string;
  isOn: boolean;
  iconClass: string;
}): HTMLElement {
  const label = document.createElement('label');
  label.className = 'awa-ucf-reading-toggle';
  label.title = options.title;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = options.isOn;
  input.className = 'awa-ucf-reading-toggle__input';
  input.dataset.awaUcfToggle = options.toggle;
  input.setAttribute('aria-label', options.label);
  input.title = options.title;

  const switchUi = document.createElement('span');
  switchUi.className = 'awa-ucf-reading-toggle__switch';
  switchUi.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'awa-ucf-reading-toggle__text';
  const icon = createIcon(options.iconClass);
  if (options.toggle === 'reading') {
    icon.dataset.awaUcfIcon = 'reading';
  }
  text.append(icon, document.createTextNode(options.label));

  label.append(input, text, switchUi);
  input.addEventListener('change', () => {
    if (options.toggle === 'reading') {
      void setLayout({ isReading: input.checked });
      return;
    }
    void setLayout({ isClassicTables: input.checked });
  });
  return label;
}

function shouldReduceMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function stickyOffsetPx(): number {
  const header = document.querySelector<HTMLElement>('.forums__header');
  const headerHeight = header?.getBoundingClientRect().height ?? 0;
  return NAVBAR_OFFSET_PX + headerHeight + STICKY_GAP_PX;
}

function postTopElement(): HTMLElement | undefined {
  return (
    document.querySelector<HTMLElement>('article.discussion__op') ??
    document.querySelector<HTMLElement>('[id^="post-content-"]') ??
    undefined
  );
}

function postBottomElement(): HTMLElement | undefined {
  return (
    document.querySelector<HTMLElement>('.discussion__op-actions') ??
    document.querySelector<HTMLElement>('[id^="post-content-"]') ??
    undefined
  );
}

function scrollToPostEdge(edge: 'top' | 'bottom'): void {
  const behavior = shouldReduceMotion() ? 'auto' : 'smooth';
  const target = edge === 'top' ? postTopElement() : postBottomElement();
  if (!target) {
    scrollTo({
      top: edge === 'top' ? 0 : document.documentElement.scrollHeight,
      behavior,
    });
    return;
  }

  const top = scrollY + target.getBoundingClientRect().top - stickyOffsetPx();
  scrollTo({ top: Math.max(0, top), behavior });
}

function buildJumpButton(
  edge: 'top' | 'bottom',
  label: string,
  iconClass: string,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'awa-ucf-jump__btn';
  const description =
    edge === 'top'
      ? 'Jump to the top of this post'
      : 'Jump to the bottom of this post';
  button.title = description;
  button.setAttribute('aria-label', description);
  button.append(createIcon(iconClass), document.createTextNode(` ${label}`));
  button.addEventListener('click', () => {
    scrollToPostEdge(edge);
  });
  return button;
}

function buildJumpControls(): HTMLElement {
  const group = document.createElement('div');
  group.id = JUMP_ID;
  group.append(
    buildJumpButton('top', 'Top', 'fa fa-chevron-up'),
    buildJumpButton('bottom', 'Bottom', 'fa fa-chevron-down'),
  );
  return group;
}

function buildReadingBar(state: UcfLayoutState): HTMLElement {
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.append(
    buildSwitch({
      toggle: 'reading',
      label: 'Reading mode',
      title:
        'Hide the board list and compact author columns so the post uses the full width',
      isOn: state.isReading,
      iconClass: expandIconClass(
        state.isReading,
        'awa-ucf-reading-toggle__icon',
      ),
    }),
    buildSwitch({
      toggle: 'tables',
      label: 'Classic tables',
      title:
        'Restore table borders and header styling. The published forum view strips them',
      isOn: state.isClassicTables,
      iconClass: 'fa fa-table awa-ucf-reading-toggle__icon',
    }),
    buildJumpControls(),
  );
  return bar;
}

function buildActionButton(state: UcfLayoutState): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = ACTION_ID;
  button.className = 'btn btn-default';
  button.setAttribute('aria-pressed', state.isReading ? 'true' : 'false');
  button.title = 'Reading mode';

  const icon = createIcon(expandIconClass(state.isReading));
  const label = document.createElement('span');
  label.className = 'hidden-xs awa-ucf-reading-action-label';
  label.textContent = state.isReading ? 'Exit reading mode' : 'Reading mode';

  button.append(icon, document.createTextNode(' '), label);
  button.addEventListener('click', () => {
    void setLayout({ isReading: !layoutStateFromDom().isReading });
  });
  return button;
}

function mountReadingBar(state: UcfLayoutState): void {
  if (document.querySelector(`#${BAR_ID}`)) {
    syncToggleUi(state);
    return;
  }

  const bar = buildReadingBar(state);
  const header = document.querySelector<HTMLElement>('.forums__header');
  if (header) {
    header.prepend(bar);
    return;
  }

  const title = document.querySelector<HTMLElement>('.discussion__op-title');
  if (title) {
    title.prepend(bar);
    return;
  }

  document.querySelector('article.discussion__op')?.prepend(bar);
}

function mountActionButton(state: UcfLayoutState): void {
  if (document.querySelector(`#${ACTION_ID}`)) {
    syncToggleUi(state);
    return;
  }

  const group = document.querySelector<HTMLElement>(
    '.discussion__op-actions .btn-group',
  );
  if (!group) {
    return;
  }
  group.append(buildActionButton(state));
}

function observeForRerender(): void {
  const root = document.querySelector('#main') ?? document.body;
  const observer = new MutationObserver(() => {
    const state = layoutStateFromDom();
    if (
      !document.querySelector(`#${BAR_ID}`) ||
      !document.querySelector(`#${ACTION_ID}`)
    ) {
      mountReadingBar(state);
      mountActionButton(state);
    }
    if (state.isClassicTables) {
      prepareTables();
    }
  });
  observer.observe(root, { childList: true, subtree: true });
}

export async function initUcfReadingMode(): Promise<void> {
  if (!isUcfPostPage()) {
    return;
  }

  ensureStyles();
  const state = await loadLayoutState();
  applyLayout(state);
  if (state.isClassicTables) {
    prepareTables();
  }
  mountReadingBar(state);
  mountActionButton(state);
  observeForRerender();
}
