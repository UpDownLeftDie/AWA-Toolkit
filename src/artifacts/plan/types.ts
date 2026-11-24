export type ActionTone = 'default' | 'muted' | 'warn';

/**
Ready-now loadout the Equip button on a What-to-do step should apply.
*/
export type EquipComboKey = 'best' | 'allArp';

/**
How a step competes in the final "What to do" order.

Sort: kind → readyAt → chain → duration → deadline slack → ARP.
Ready-now actions beat scheduled waits. Dailies delayed until a later
All-ARP% equip use kind "schedule" so they sit after that equip (chain)
instead of jumping to #1 when 00:00 UTC refreshes Watch Twitch.
*/
export type ActionTodoUrgencyKind = 'action' | 'schedule' | 'info';

/**
Soft dependency relative to an equip/swap step.
*/
export type ActionTodoChain = 'before' | 'equip' | 'after';

export interface ActionTodoUrgency {
  kind: ActionTodoUrgencyKind;
  /**
  ms until the user can start (0 = now).
  */
  readyAtMs: number;
  /**
  ms to finish once started (0 = instant click).
  */
  durationMs: number;
  /**
  ms until a hard loss deadline; omit when none.
  */
  deadlineMs?: number;
  /**
  ARP at stake for tie-breaks.
  */
  arp?: number;
  chain?: ActionTodoChain;
}

export interface ActionTodoReason {
  text: string;
  /**
  Secondary line under this reason (e.g. community progress / ETA).
  */
  detail?: string;
}

export interface ActionTodo {
  text: string;
  /**
  Artifact names on their own line under the headline.
  */
  loadout?: string;
  /**
  Why / what this step is for — rendered as a short list.
  */
  reasons?: ActionTodoReason[];
  tone?: ActionTone;
  /**
  Unnumbered warning above the list (don't-do-this), not a step.
  */
  kind?: 'caution';
  /**
  Ready-now loadout swap — renders a confirm+Equip button on this step.
  `best` is the recommended/partial plan; `allArp` is the 0% All-ARP% set.
  */
  equipCombo?: EquipComboKey;
  /**
  Affordable META upgrade — renders a confirm+Upgrade button on this step.
  */
  upgradeInstanceId?: number;
  /**
  Ready Battle Pass rewards — renders a claim button on this step.
  */
  claimBattlePass?: boolean;
  /**
  Leave ARP Boosts unclaimed (All-ARP% wait). Claim cosmetics/fragments only.
  */
  claimBattlePassSkipArp?: boolean;
  /**
  Enroll in the current Battle Pass (Start) — ARP progress only counts after.
  */
  startBattlePass?: boolean;
  /**
  Watch Twitch step — renders an Open stream button that picks a live channel.
  */
  openTwitchStream?: boolean;
  /**
  Achievement helper — navigate (or background-visit) this path.
  */
  openHref?: string;
  openHrefLabel?: string;
  /**
  Fetch the href in a hidden request instead of leaving the page.
  */
  visitInBackground?: boolean;
  /**
  Final list order — phases still decide wording / swap sequencing metadata.
  */
  urgency?: ActionTodoUrgency;
}

export function isCautionTodo(todo: ActionTodo): boolean {
  return todo.kind === 'caution';
}
