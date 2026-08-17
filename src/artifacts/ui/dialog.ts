import {
  areAccountActionsEnabled,
  getArtifactSettings,
} from '../settings';
import { escapeHtml } from './loadoutPlan';
import { DIALOG_ID, TOAST_ID, TOAST_MS, ensureOptimizerStyles } from './styles';

const dialogState: {
  resolve?: (isConfirmed: boolean) => void;
  keyListener?: (event: KeyboardEvent) => void;
  doesEscapeConfirm?: boolean;
} = {};

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAoDialog(dialogState.doesEscapeConfirm === true);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAoDialog(true);
  }
}

function closeAoDialog(isConfirmed: boolean): void {
  if (dialogState.keyListener) {
    document.removeEventListener('keydown', dialogState.keyListener, {
      capture: true,
    });
    delete dialogState.keyListener;
  }
  const resolve = dialogState.resolve;
  delete dialogState.resolve;
  delete dialogState.doesEscapeConfirm;
  document.querySelector(`#${DIALOG_ID}`)?.remove();
  resolve?.(isConfirmed);
}

export function showAoDialog(options: {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDanger?: boolean;
}): Promise<boolean> {
  ensureOptimizerStyles();
  closeAoDialog(false);

  const root = document.createElement('div');
  root.id = DIALOG_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const title = options.title ?? 'Artifact Optimizer';
  root.setAttribute('aria-label', title);
  const cancelButton = options.cancelLabel
    ? `<button type="button" class="ao-secondary" data-ao-dialog="cancel">${escapeHtml(options.cancelLabel)}</button>`
    : '';
  const confirmClass = options.isDanger === true ? 'ao-danger' : '';
  root.innerHTML = `
    <div class="ao-dialog-scrim" data-ao-dialog="cancel"></div>
    <div class="ao-dialog">
      <div class="ao-dialog-title">${escapeHtml(title)}</div>
      <div class="ao-dialog-message">${escapeHtml(options.message)}</div>
      <div class="ao-dialog-actions">
        ${cancelButton}
        <button type="button" class="${confirmClass}" data-ao-dialog="ok">${escapeHtml(options.confirmLabel ?? 'OK')}</button>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    dialogState.resolve = resolve;
    root.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const actionElement = target.closest('[data-ao-dialog]');
      if (!(actionElement instanceof HTMLElement)) {
        return;
      }
      const action = actionElement.dataset.aoDialog;
      if (action === 'ok') {
        closeAoDialog(true);
        return;
      }
      if (action === 'cancel') {
        closeAoDialog(!options.cancelLabel);
      }
    });
    dialogState.doesEscapeConfirm = !options.cancelLabel;
    dialogState.keyListener = onDialogKeydown;
    document.addEventListener('keydown', onDialogKeydown, { capture: true });
    document.body.append(root);
    root.querySelector<HTMLButtonElement>('[data-ao-dialog="ok"]')?.focus();
  });
}

export async function showAoAlert(
  message: string,
  title?: string,
): Promise<void> {
  await showAoDialog({
    message,
    ...(title && { title }),
    confirmLabel: 'OK',
  });
}

export async function didConfirmAoDialog(
  message: string,
  options: { title?: string; confirmLabel?: string; isDanger?: boolean } = {},
): Promise<boolean> {
  return showAoDialog({
    message,
    cancelLabel: 'Cancel',
    confirmLabel: options.confirmLabel ?? 'Confirm',
    ...(options.title && { title: options.title }),
    ...(options.isDanger === true && { isDanger: true }),
  });
}

export function showAoToast(message: string): void {
  ensureOptimizerStyles();
  document.querySelector(`#${TOAST_ID}`)?.remove();
  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => {
    toast.remove();
  }, TOAST_MS);
}

const ACCOUNT_ACTIONS_OFF_MESSAGE =
  'Account actions are off. Enable them in the full panel.';

export async function didAllowAccountActions(): Promise<boolean> {
  if (areAccountActionsEnabled(await getArtifactSettings())) {
    return true;
  }
  await showAoAlert(ACCOUNT_ACTIONS_OFF_MESSAGE, 'Account actions off');
  return false;
}
