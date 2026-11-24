export type TaskKind = 'action' | 'schedule' | 'info' | 'caution';
export type TaskChain = 'before' | 'equip' | 'after';

export interface TaskReason {
  text: string;
  detail?: string;
}

export type TaskAction =
  | { type: 'equip'; combo: 'best' | 'allArp' }
  | { type: 'claimBattlePass'; skipArp?: boolean }
  | { type: 'startBattlePass'; openHref?: string; openHrefLabel?: string }
  | { type: 'openTwitchStream' }
  | { type: 'upgrade'; instanceId: number }
  | {
      type: 'openHref';
      href: string;
      label?: string;
      visitInBackground?: boolean;
    };

export interface TaskCandidate {
  id: string;
  kind: TaskKind;
  value: { arp?: number };
  timing: { readyAtMs: number; durationMs: number; deadlineMs?: number };
  constraints: {
    after?: string[];
    before?: string[];
    pinFirst?: boolean;
    chain?: TaskChain;
  };
  display: {
    text: string;
    loadout?: string;
    reasons?: TaskReason[];
    tone?: 'default' | 'muted' | 'warn';
  };
  action?: TaskAction;
}

export interface NamedComparator {
  id: string;
  compare(a: TaskCandidate, b: TaskCandidate): number;
}

export interface RankDecision {
  taskId: string;
  rank: number;
  reasons: string[];
}

export interface RankResult {
  ordered: TaskCandidate[];
  trace: RankDecision[];
}

export type PriorityPolicyId =
  | 'lifetimeArp'
  | 'marketplaceDiscount'
  | 'gameVaultDiscount';

export interface PriorityPolicy {
  id: PriorityPolicyId;
  comparators: readonly NamedComparator[];
}

export type TaskProviderContext = Record<string, unknown>;

export interface TaskProvider {
  id: string;
  provide(context: TaskProviderContext): TaskCandidate[];
}
