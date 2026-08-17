export const MODAL_ID = 'alienware-artifact-optimizer';
export const INLINE_ID = 'alienware-artifact-optimizer-inline';
export const CC_PANEL_ID = 'alienware-artifact-optimizer-cc';
export const BP_CLAIM_BAR_ID = 'alienware-artifact-optimizer-bp-claim';
export const STYLE_ID = 'alienware-artifact-optimizer-styles';
export const BACKDROP_ID = 'alienware-artifact-optimizer-backdrop';
export const DIALOG_ID = 'alienware-artifact-optimizer-dialog';
export const TOAST_ID = 'alienware-artifact-optimizer-toast';
export const TOAST_MS = 2200;

/**
Shared modal positioning — light-DOM CSS, shadow :host, and inline !important.
*/
export const MODAL_LAYOUT: ReadonlyArray<readonly [string, string]> = [
  ['position', 'fixed'],
  ['top', '50%'],
  ['left', '50%'],
  ['transform', 'translate(-50%, -50%)'],
  ['z-index', '10001'],
  ['width', 'min(560px, 94vw)'],
  ['max-height', '90vh'],
  ['overflow-y', 'auto'],
];

export const BACKDROP_LAYOUT: ReadonlyArray<readonly [string, string]> = [
  ['position', 'fixed'],
  ['inset', '0'],
  ['background', 'rgba(0, 0, 0, 0.85)'],
  ['z-index', '10000'],
];

function cssDeclarations(
  layout: ReadonlyArray<readonly [string, string]>,
): string {
  return layout
    .map(([property, value]) => `${property}: ${value};`)
    .join('\n        ');
}

/**
Host-only chrome for light DOM. Panel paint lives in each shadow tree.
*/
function buildOptimizerCss(): string {
  return `
      #${BACKDROP_ID} {
        display: none;
        ${cssDeclarations(BACKDROP_LAYOUT)}
      }
      #${MODAL_ID} {
        display: none;
        ${cssDeclarations(MODAL_LAYOUT)}
        background: transparent;
      }
      #${INLINE_ID},
      #${CC_PANEL_ID} {
        display: block;
        margin: 16px 0;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
      }
      body > #${INLINE_ID},
      body > #${CC_PANEL_ID},
      html > #${INLINE_ID},
      html > #${CC_PANEL_ID} {
        margin: 88px auto 16px;
        padding: 0 16px;
        max-width: 1100px;
      }
      #${DIALOG_ID} {
        position: fixed;
        inset: 0;
        z-index: 10002;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #${DIALOG_ID}[hidden] {
        display: none !important;
      }
      #${DIALOG_ID} .ao-dialog-scrim {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.85);
      }
      #${DIALOG_ID} .ao-dialog {
        position: relative;
        z-index: 1;
        width: min(420px, 92vw);
        background: #1a1a1a;
        color: #fff;
        border: 1px solid #00bc8c;
        border-radius: 8px;
        padding: 20px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.85);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 14px;
        line-height: 1.45;
      }
      #${DIALOG_ID} .ao-dialog-title {
        margin: 0 0 10px;
        color: #00bc8c;
        font-size: 1.1em;
        font-weight: bold;
      }
      #${DIALOG_ID} .ao-dialog-message {
        margin: 0 0 16px;
        color: #eee;
        white-space: pre-wrap;
      }
      #${DIALOG_ID} .ao-dialog-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }
      #${DIALOG_ID} button {
        background: #00bc8c;
        color: #fff;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      }
      #${DIALOG_ID} button.ao-secondary {
        background: #555;
      }
      #${DIALOG_ID} button.ao-danger {
        background: #e74c3c;
      }
      #${TOAST_ID} {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10003;
        max-width: min(420px, 92vw);
        background: #1a1a1a;
        color: #fff;
        border: 1px solid #00bc8c;
        border-radius: 8px;
        padding: 10px 16px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 14px;
      }
      #${TOAST_ID}[hidden] {
        display: none !important;
      }
  `;
}

export function ensureOptimizerStyles(): void {
  let style = document.querySelector<HTMLStyleElement>(`#${STYLE_ID}`);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    (document.head || document.documentElement).append(style);
  }
  style.textContent = buildOptimizerCss();
}

export function applyOpaqueModalChrome(modal: HTMLElement): void {
  const paint: Array<readonly [string, string]> = [
    ...MODAL_LAYOUT,
    ['background', 'transparent'],
    ['opacity', '1'],
  ];
  for (const [property, value] of paint) {
    modal.style.setProperty(property, value, 'important');
  }
}

export function applyOpaqueBackdropChrome(backdrop: HTMLElement): void {
  const paint: Array<readonly [string, string]> = [
    ...BACKDROP_LAYOUT,
    ['background-color', 'rgba(0, 0, 0, 0.85)'],
    ['opacity', '1'],
  ];
  for (const [property, value] of paint) {
    backdrop.style.setProperty(property, value, 'important');
  }
}

type PanelShadowVariant = 'modal' | 'inline';

function buildPanelShadowCss(variant: PanelShadowVariant): string {
  const hostCss =
    variant === 'modal'
      ? `
    :host {
      display: none;
      ${cssDeclarations(MODAL_LAYOUT)}
      box-sizing: border-box;
    }
  `
      : `
    :host {
      display: block;
      margin: 0;
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
    }
  `;

  return `
    ${hostCss}
    .ao-panel,
    .ao-panel * {
      text-decoration: none !important;
      text-decoration-line: none !important;
      -webkit-text-fill-color: unset !important;
      text-transform: none !important;
      letter-spacing: normal !important;
      text-shadow: none !important;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif !important;
      box-sizing: border-box;
    }
    .ao-panel {
      display: block;
      background: #1a1a1a;
      color: #fff;
      padding: ${variant === 'modal' ? '20px' : '16px'};
      border-radius: 8px;
      border: 1px solid ${variant === 'modal' ? '#444' : '#00bc8c'};
      box-shadow: ${
        variant === 'modal'
          ? '0 12px 40px rgba(0, 0, 0, 0.85)'
          : '0 0 10px rgba(0, 188, 140, 0.25)'
      };
      font-size: 14px;
      line-height: 1.4;
      width: 100%;
    }
    .ao-panel > * {
      display: block;
      width: 100%;
    }
    .ao-title {
      color: #fff !important;
      font-size: 1.4em !important;
      font-weight: bold !important;
      margin: 0 0 12px !important;
    }
    .ao-heading {
      color: #00bc8c !important;
      font-size: 1.05em !important;
      font-weight: bold !important;
      margin: 14px 0 8px !important;
    }
    .ao-heading:first-child {
      margin-top: 0 !important;
    }
    .ao-row {
      display: block;
      margin: 6px 0 6px 8px;
      color: #fff !important;
      line-height: 1.4;
    }
    .ao-muted {
      color: #aaa !important;
      font-size: 0.9em !important;
    }
    .ao-credit {
      margin: 0 0 10px !important;
    }
    .ao-note {
      display: block;
      background: #2a2a2a;
      border-left: 3px solid #00bc8c;
      padding: 8px 10px;
      margin: 8px 0;
      color: #eee !important;
    }
    .ao-note > div + div {
      margin-top: 4px;
    }
    .ao-note-actions {
      margin-top: 8px;
    }
    .ao-status-details {
      margin: 8px 0 4px;
    }
    .ao-status-details summary {
      cursor: pointer;
      user-select: none;
    }
    .ao-status-details[open] summary {
      margin-bottom: 6px;
    }
    .ao-text-link {
      color: #00bc8c !important;
      text-decoration: underline !important;
      text-decoration-line: underline !important;
      cursor: pointer;
    }
    .ao-actions {
      display: flex !important;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
      width: 100%;
    }
    .ao-actions-sep {
      width: 1px;
      align-self: stretch;
      min-height: 28px;
      background: #555;
      margin: 0 4px;
    }
    .ao-todo-list {
      display: block;
      margin: 0 0 4px;
      padding: 0;
      list-style: none;
      width: 100%;
    }
    .ao-divider {
      display: block;
      border: 0;
      border-top: 1px solid #444;
      margin: 14px 0;
      width: 100%;
    }
    .ao-todo-item {
      display: flex;
      gap: 6px;
      margin: 6px 0;
      line-height: 1.45;
      color: #eee !important;
      align-items: flex-start;
    }
    .ao-todo-index {
      color: #00bc8c !important;
      font-weight: 600;
      flex: 0 0 auto;
      padding-top: 1px;
    }
    .ao-todo-item > .ao-upgrade-btn,
    .ao-todo-item > .ao-claim-btn,
    .ao-todo-item > .ao-twitch-btn {
      flex: 0 0 auto;
      padding: 4px 10px;
      font-size: 13px !important;
    }
    .ao-row .ao-upgrade-btn {
      margin-left: 8px;
    }
    .ao-todo-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .ao-todo-headline {
      display: block;
      font-weight: 600;
    }
    .ao-todo-loadout {
      display: block;
      color: #fff !important;
      margin: 2px 0 2px;
    }
    .ao-todo-reasons {
      display: block;
      margin: 4px 0 0;
      padding: 0 0 0 1.1em;
      list-style: disc;
      color: #ccc !important;
    }
    .ao-todo-reasons > li {
      display: list-item;
      margin: 2px 0;
    }
    .ao-todo-reason-text {
      display: block;
    }
    .ao-todo-reason-detail {
      display: block;
      margin-top: 1px;
      color: #aaa !important;
      font-size: 0.92em;
    }
    .ao-todo-muted {
      color: #aaa !important;
    }
    .ao-todo-warn {
      color: #f0c674 !important;
    }
    .ao-caution {
      display: block;
      margin: 0 0 10px;
      padding: 8px 10px;
      border: 1px solid #f0c674;
      border-radius: 6px;
      background: rgba(240, 198, 116, 0.12);
      color: #f0c674 !important;
    }
    .ao-caution .ao-todo-headline {
      font-weight: 700;
    }
    .ao-caution .ao-todo-reasons {
      color: #e6d5a3 !important;
      padding-left: 1.1em;
    }
    button {
      display: inline-block;
      width: auto;
      background: #00bc8c;
      color: #fff !important;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px !important;
    }
    button[hidden] {
      display: none !important;
    }
    button.ao-secondary {
      background: #555;
    }
    button.ao-loadout-preview {
      white-space: normal;
      text-align: left;
      max-width: 100%;
    }
    button.ao-danger {
      background: #e74c3c;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    label.ao-toggle {
      display: block;
      margin: 4px 0 4px 8px;
      color: #fff !important;
    }
    input[type="number"],
    input[type="text"],
    select,
    textarea.ao-textarea {
      width: 90px;
      margin-left: 6px;
      padding: 2px 4px;
      background: #2a2a2a;
      color: #fff !important;
      border: 1px solid #555;
      border-radius: 3px;
      caret-color: #fff;
      font-size: 14px !important;
    }
    textarea.ao-textarea {
      display: block;
      width: calc(100% - 8px);
      min-height: 72px;
      margin: 6px 0 6px 8px;
      resize: vertical;
    }
    select {
      width: auto;
      min-width: 120px;
    }
    input[type="checkbox"] {
      margin-right: 6px;
      accent-color: #00bc8c;
    }
    .ao-notify {
      display: block;
      margin: 0 0 12px;
      padding: 10px 12px;
      background: #222;
      border: 1px solid #333;
      border-radius: 8px;
    }
    .ao-switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin: 0;
      cursor: pointer;
      color: #fff !important;
    }
    .ao-switch-copy {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .ao-switch-title {
      font-weight: 600;
      color: #fff !important;
    }
    .ao-switch-hint {
      color: #aaa !important;
      font-size: 0.88em !important;
      line-height: 1.4;
    }
    .ao-switch-input {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .ao-switch-track {
      position: relative;
      flex: 0 0 auto;
      width: 44px;
      height: 24px;
      border-radius: 999px;
      background: #3a3a3a;
      box-shadow: inset 0 0 0 1px #555;
      transition: background 0.16s ease, box-shadow 0.16s ease;
    }
    .ao-switch-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
      transition: transform 0.16s ease;
    }
    .ao-switch-input:checked + .ao-switch-track {
      background: #00bc8c;
      box-shadow: inset 0 0 0 1px #00bc8c;
    }
    .ao-switch-input:checked + .ao-switch-track .ao-switch-knob {
      transform: translateX(20px);
    }
    .ao-switch-input:focus-visible + .ao-switch-track {
      outline: 2px solid #00bc8c;
      outline-offset: 3px;
    }
    .ao-notify-types {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #333;
    }
    .ao-notify-types[data-off] {
      opacity: 0.45;
      pointer-events: none;
    }
    .ao-switch-sm .ao-switch-title {
      font-weight: 500;
      font-size: 0.92em !important;
    }
    .ao-switch-sm .ao-switch-hint {
      font-size: 0.8em !important;
    }
    .ao-switch-sm .ao-switch-track {
      width: 36px;
      height: 20px;
    }
    .ao-switch-sm .ao-switch-knob {
      width: 16px;
      height: 16px;
    }
    .ao-switch-sm .ao-switch-input:checked + .ao-switch-track .ao-switch-knob {
      transform: translateX(16px);
    }
    details {
      display: block;
      width: 100%;
    }
    details.ao-advanced {
      margin-top: 14px;
      border-top: 1px solid #333;
      padding-top: 10px;
    }
    details.ao-advanced > summary {
      cursor: pointer;
      color: #00bc8c !important;
      font-weight: bold;
      list-style: none;
    }
    details.ao-advanced > summary::-webkit-details-marker {
      display: none;
    }
    details.ao-advanced > summary::before {
      content: '▸ ';
    }
    details.ao-advanced[open] > summary::before {
      content: '▾ ';
    }
    details > summary {
      color: #aaa !important;
      cursor: pointer;
    }
    .ao-hydrate {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 10px;
      padding: 8px 10px;
      background: #222;
      border: 1px solid #00bc8c55;
      border-radius: 4px;
      color: #ccc !important;
      font-size: 0.92em !important;
    }
    .ao-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #00bc8c44;
      border-top-color: #00bc8c;
      border-radius: 50%;
      animation: ao-spin 0.7s linear infinite;
      flex: 0 0 auto;
    }
    .ao-skel {
      display: block;
      height: 12px;
      margin: 8px 0;
      border-radius: 4px;
      background: linear-gradient(90deg, #2a2a2a 25%, #333 37%, #2a2a2a 63%);
      background-size: 400% 100%;
      animation: ao-skel 1.2s ease-in-out infinite;
    }
    @keyframes ao-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes ao-skel {
      0% {
        background-position: 100% 0;
      }
      100% {
        background-position: 0 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .ao-spinner,
      .ao-skel {
        animation: none;
      }
      .ao-switch-track,
      .ao-switch-knob {
        transition: none;
      }
    }
  `;
}

export function buildModalShadowCss(): string {
  return buildPanelShadowCss('modal');
}

export function buildInlineShadowCss(): string {
  return buildPanelShadowCss('inline');
}
