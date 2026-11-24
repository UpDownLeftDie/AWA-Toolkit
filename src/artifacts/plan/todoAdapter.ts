import type { TaskAction, TaskCandidate, TaskKind } from '../../planner';
import type {
  ActionTodo,
  ActionTodoUrgency,
} from './types';

/**
Convert an ActionTodo into a domain-agnostic TaskCandidate for ranking.
*/
export function actionTodoToTask(
  todo: ActionTodo,
  id: string,
): TaskCandidate {
  const isCaution = todo.kind === 'caution';
  const urgency = todo.urgency;

  let kind: TaskKind;
  if (isCaution) {
    kind = 'caution';
  } else if (urgency?.kind === undefined) {
    kind = todo.tone === 'muted' && !todo.loadout ? 'info' : 'action';
  } else {
    kind = urgency.kind;
  }

  const task: TaskCandidate = {
    id,
    kind,
    value: {},
    timing: {
      readyAtMs: urgency?.readyAtMs ?? 0,
      durationMs: urgency?.durationMs ?? 0,
    },
    constraints: {},
    display: {
      text: todo.text,
    },
  };

  if (urgency?.arp !== undefined) {
    task.value.arp = urgency.arp;
  }

  if (urgency?.deadlineMs !== undefined) {
    task.timing.deadlineMs = urgency.deadlineMs;
  }

  if (urgency?.chain !== undefined) {
    task.constraints.chain = urgency.chain;
  }
  if (todo.startBattlePass === true) {
    task.constraints.pinFirst = true;
  }

  if (todo.loadout !== undefined) {
    task.display.loadout = todo.loadout;
  }
  if (todo.reasons !== undefined && todo.reasons.length > 0) {
    task.display.reasons = todo.reasons;
  }
  if (todo.tone !== undefined) {
    task.display.tone = todo.tone;
  }

  const action = resolveAction(todo);
  if (action !== undefined) {
    task.action = action;
  }

  return task;
}

function resolveAction(todo: ActionTodo): TaskAction | undefined {
  if (todo.equipCombo !== undefined) {
    return { type: 'equip', combo: todo.equipCombo };
  }
  if (todo.startBattlePass === true) {
    const action: TaskAction & { type: 'startBattlePass' } = {
      type: 'startBattlePass',
    };
    if (todo.openHref !== undefined) {
      action.openHref = todo.openHref;
      if (todo.openHrefLabel !== undefined) {
        action.openHrefLabel = todo.openHrefLabel;
      }
    }
    return action;
  }
  if (todo.claimBattlePass === true) {
    return {
      type: 'claimBattlePass',
      ...(todo.claimBattlePassSkipArp === true && { skipArp: true }),
    };
  }
  if (todo.openTwitchStream === true) {
    return { type: 'openTwitchStream' };
  }
  if (todo.upgradeInstanceId !== undefined) {
    return { type: 'upgrade', instanceId: todo.upgradeInstanceId };
  }
  if (todo.openHref !== undefined) {
    return {
      type: 'openHref',
      href: todo.openHref,
      ...(todo.openHrefLabel !== undefined && { label: todo.openHrefLabel }),
      ...(todo.visitInBackground === true && { visitInBackground: true }),
    };
  }
  return undefined;
}

/**
Convert a ranked TaskCandidate back into an ActionTodo for rendering.
*/
export function taskToActionTodo(task: TaskCandidate): ActionTodo {
  const todo: ActionTodo = {
    text: task.display.text,
  };

  if (task.kind === 'caution') {
    todo.kind = 'caution';
  }

  if (task.display.loadout !== undefined) {
    todo.loadout = task.display.loadout;
  }
  if (task.display.reasons !== undefined && task.display.reasons.length > 0) {
    todo.reasons = task.display.reasons;
  }
  if (task.display.tone !== undefined) {
    todo.tone = task.display.tone;
  }

  if (task.action !== undefined) {
    applyAction(todo, task.action);
  }

  if (task.kind !== 'caution') {
    const urgency: ActionTodoUrgency = {
      kind: task.kind,
      readyAtMs: task.timing.readyAtMs,
      durationMs: task.timing.durationMs,
    };
    if (task.timing.deadlineMs !== undefined) {
      urgency.deadlineMs = task.timing.deadlineMs;
    }
    if (task.value.arp !== undefined) {
      urgency.arp = task.value.arp;
    }
    if (task.constraints.chain !== undefined) {
      urgency.chain = task.constraints.chain;
    }
    todo.urgency = urgency;
  }

  return todo;
}

function applyAction(todo: ActionTodo, action: TaskAction): void {
  switch (action.type) {
    case 'equip': {
      todo.equipCombo = action.combo;
      break;
    }
    case 'claimBattlePass': {
      todo.claimBattlePass = true;
      if (action.skipArp === true) {
        todo.claimBattlePassSkipArp = true;
      }
      break;
    }
    case 'startBattlePass': {
      todo.startBattlePass = true;
      if (action.openHref !== undefined) {
        todo.openHref = action.openHref;
        if (action.openHrefLabel !== undefined) {
          todo.openHrefLabel = action.openHrefLabel;
        }
      }
      break;
    }
    case 'openTwitchStream': {
      todo.openTwitchStream = true;
      break;
    }
    case 'upgrade': {
      todo.upgradeInstanceId = action.instanceId;
      break;
    }
    case 'openHref': {
      todo.openHref = action.href;
      if (action.label !== undefined) {
        todo.openHrefLabel = action.label;
      }
      if (action.visitInBackground === true) {
        todo.visitInBackground = true;
      }
      break;
    }
  }
}
