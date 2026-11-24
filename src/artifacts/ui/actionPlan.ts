// Domain types and planning logic now live in artifacts/plan/.
// This module re-exports for backward compatibility and keeps render-only code.

export { buildActionPlan, buildActionPlanDetailed, isKeepingCurrentLoadout } from '../plan/buildActionPlan';
export type {
  ActionTodo,
  ActionTodoChain,
  ActionTodoReason,
  ActionTodoUrgency,
  ActionTodoUrgencyKind,
  ActionTone,
  EquipComboKey,
} from '../plan/types';
import { isCautionTodo, type ActionTodo } from '../plan/types';
import type { RankDecision } from '../../planner';
import { formatMs } from '../loadoutFormat';
import { wrapArtifactNames } from './artifactTip';
import {
  battlePassClaimButtonLabel,
} from '../siteState/battlePass';
import { escapeHtml } from './loadoutPlan';

// ── Render helpers (UI-only, not moved to plan/) ───────────────────────

function actionTodoToneClass(tone: ActionTodo['tone']): string {
  if (tone === 'warn') {
    return ' ao-todo-warn';
  }
  return tone === 'muted' ? ' ao-todo-muted' : '';
}

function renderActionTodoBody(todo: ActionTodo): string {
  const parts = [
    `<span class="ao-todo-headline">${wrapArtifactNames(todo.text)}</span>`,
  ];
  if (todo.loadout) {
    parts.push(
      `<span class="ao-todo-loadout">${wrapArtifactNames(todo.loadout)}</span>`,
    );
  }
  if (todo.reasons && todo.reasons.length > 0) {
    const items = todo.reasons
      .map((reason) => {
        const detail = reason.detail
          ? `<div class="ao-todo-reason-detail">${wrapArtifactNames(reason.detail)}</div>`
          : '';
        return `<li><div class="ao-todo-reason-text">${wrapArtifactNames(reason.text)}</div>${detail}</li>`;
      })
      .join('');
    parts.push(`<ul class="ao-todo-reasons">${items}</ul>`);
  }
  return parts.join('');
}

function renderAccountTodoButton(todo: ActionTodo): string {
  if (todo.equipCombo) {
    const label = todo.equipCombo === 'allArp' ? 'Equip All-ARP%' : 'Equip';
    return `<button type="button" class="ao-equip-btn" data-equip="${todo.equipCombo}">${label}</button>`;
  }
  if (todo.upgradeInstanceId !== undefined) {
    return `<button type="button" class="ao-upgrade-btn" data-id="${String(todo.upgradeInstanceId)}">Upgrade</button>`;
  }
  if (todo.startBattlePass === true) {
    return '<button type="button" class="ao-start-bp-btn">Start Battle Pass</button>';
  }
  if (todo.claimBattlePass === true) {
    const skipArp =
      todo.claimBattlePassSkipArp === true ? ' data-skip-arp="1"' : '';
    return `<button type="button" class="ao-claim-btn"${skipArp}>${battlePassClaimButtonLabel(todo.claimBattlePassSkipArp === true)}</button>`;
  }
  return '';
}

function renderTodoActionButton(
  todo: ActionTodo,
  options: { allowAccountActions?: boolean } = {},
): string {
  if (todo.openTwitchStream === true) {
    return '<button type="button" class="ao-twitch-btn">Open stream</button>';
  }
  if (
    todo.startBattlePass === true &&
    options.allowAccountActions === true
  ) {
    return renderAccountTodoButton(todo);
  }
  if (todo.openHref) {
    const visit = todo.visitInBackground === true ? ' data-visit="1"' : '';
    const label = todo.openHrefLabel ?? 'Open';
    return `<button type="button" class="ao-ach-open-btn" data-href="${escapeHtml(todo.openHref)}"${visit}>${escapeHtml(label)}</button>`;
  }
  return options.allowAccountActions === true
    ? renderAccountTodoButton(todo)
    : '';
}

export function renderActionPlanContents(
  todos: ActionTodo[],
  options: { allowAccountActions?: boolean; heading?: string } = {},
): string {
  const cautions = todos.filter((todo) => isCautionTodo(todo));
  const steps = todos.filter((todo) => !isCautionTodo(todo));
  const cautionHtml = cautions
    .map((todo) => {
      const toneClass = actionTodoToneClass(todo.tone);
      return `<div class="ao-caution${toneClass}" role="note">${renderActionTodoBody(todo)}</div>`;
    })
    .join('');
  const items = steps
    .map((todo, index) => {
      const toneClass = actionTodoToneClass(todo.tone);
      return `<li class="ao-todo-item${toneClass}"><span class="ao-todo-index">${String(index + 1)}.</span><div class="ao-todo-text">${renderActionTodoBody(todo)}</div>${renderTodoActionButton(todo, options)}</li>`;
    })
    .join('');
  const listHtml =
    steps.length > 0 ? `<ul class="ao-todo-list">${items}</ul>` : '';
  const heading = options.heading ?? 'What to do';
  return `
    <div class="ao-heading">${escapeHtml(heading)}</div>
    ${cautionHtml}
    ${listHtml}
  `;
}

/**
Turn planner rank tokens into short plain-English phrases for users.
*/
function explainRankDecision(
  decision: RankDecision,
  todo: ActionTodo | undefined,
  headlinesByTaskId: Map<string, string>,
): string {
  const reasons = decision.reasons;
  if (todo?.kind === 'caution' || reasons.includes('kind:caution')) {
    return 'Warning — shown above the numbered steps';
  }

  const parts: string[] = [];
  if (reasons.includes('pinFirst')) {
    parts.push('First — do this before anything else');
  }

  const readyToken = reasons.find((reason) => reason.startsWith('readyAt:'));
  const readyAtMs = readyToken
    ? Number(readyToken.slice('readyAt:'.length))
    : todo?.urgency?.readyAtMs;
  if (reasons.includes('kind:schedule') || (readyAtMs !== undefined && readyAtMs > 0)) {
    parts.push(
      readyAtMs !== undefined && readyAtMs > 0
        ? `Waiting — ready in ${formatMs(readyAtMs)}`
        : 'Scheduled for later',
    );
  } else if (reasons.includes('kind:action') || readyAtMs === 0) {
    parts.push('Ready now');
  } else if (reasons.includes('kind:info')) {
    parts.push('Informational');
  }

  if (reasons.includes('chain:before')) {
    parts.push('Before the loadout swap');
  } else if (reasons.includes('chain:equip')) {
    parts.push('Loadout swap step');
  } else if (reasons.includes('chain:after')) {
    parts.push('After the loadout swap');
  }

  for (const reason of reasons) {
    if (!reason.startsWith('after:')) {
      continue;
    }
    const predecessorId = reason.slice('after:'.length);
    const predecessor = headlinesByTaskId.get(predecessorId);
    parts.push(
      predecessor
        ? `After “${truncateHeadline(predecessor, 40)}”`
        : 'After an earlier step',
    );
  }

  const arpToken = reasons.find((reason) => reason.startsWith('arp:'));
  if (arpToken) {
    const arp = Number(arpToken.slice('arp:'.length));
    if (Number.isFinite(arp) && arp > 0) {
      parts.push(`~${String(Math.round(arp))} ARP at stake`);
    }
  }

  const decidedBy = reasons
    .find((reason) => reason.startsWith('decidedBy:'))
    ?.slice('decidedBy:'.length);
  if (decidedBy === 'kind') {
    parts.push('Ordered ahead of later/scheduled work');
  } else if (decidedBy === 'readyAt') {
    parts.push('Sooner unlock than the next step');
  } else if (decidedBy === 'chain') {
    parts.push('Swap sequencing');
  } else if (decidedBy === 'duration') {
    parts.push('Shorter step first');
  } else if (decidedBy === 'slack') {
    parts.push('Tighter deadline');
  } else if (decidedBy === 'arp') {
    parts.push('Higher ARP than the next step');
  }

  if (reasons.includes('constraintCycle')) {
    parts.push('Dependency loop broken by ARP rules');
  }

  const unique = [...new Set(parts.filter((part) => part.length > 0))];
  return unique.length > 0 ? unique.join(' · ') : 'Ranked by lifetime ARP rules';
}

function truncateHeadline(text: string, max = 72): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function renderRankTrace(
  trace: RankDecision[],
  todos: ActionTodo[],
): string {
  if (trace.length === 0) {
    return '';
  }
  const headlinesByTaskId = new Map<string, string>();
  for (let i = 0; i < trace.length; i += 1) {
    const decision = trace[i];
    if (decision === undefined) {
      continue;
    }
    const todo = todos[i];
    headlinesByTaskId.set(decision.taskId, todo?.text ?? decision.taskId);
  }
  const items = trace
    .map((decision, index) => {
      const todo = todos[index];
      const headline = truncateHeadline(todo?.text ?? decision.taskId);
      const why = explainRankDecision(decision, todo, headlinesByTaskId);
      return `<li class="ao-trace-item"><span class="ao-todo-index">${String(index + 1)}.</span><div class="ao-todo-text"><span class="ao-todo-headline">${wrapArtifactNames(headline)}</span><div class="ao-todo-reason-detail">${escapeHtml(why)}</div></div></li>`;
    })
    .join('');
  return `
    <details class="ao-status-details ao-rank-trace">
      <summary class="ao-muted">Why this order?</summary>
      <ul class="ao-todo-list ao-trace-list">${items}</ul>
    </details>
  `;
}

export function renderActionPlan(
  todos: ActionTodo[],
  options: { allowAccountActions?: boolean; trace?: RankDecision[] } = {},
): string {
  const traceHtml = options.trace
    ? renderRankTrace(options.trace, todos)
    : '';
  return `<div id="ao-action-plan">${renderActionPlanContents(todos, options)}${traceHtml}</div>`;
}
