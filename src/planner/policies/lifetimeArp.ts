import type {
  NamedComparator,
  PriorityPolicy,
  TaskCandidate,
} from '../types';

const KIND_RANK: Record<string, number> = {
  action: 0,
  schedule: 1,
  info: 2,
};

const CHAIN_RANK: Record<string, number> = {
  before: 0,
  equip: 1,
  after: 2,
};

function taskDeadlineMs(task: TaskCandidate): number {
  return task.timing.deadlineMs ?? Number.POSITIVE_INFINITY;
}

const kindComparator: NamedComparator = {
  id: 'kind',
  compare(a: TaskCandidate, b: TaskCandidate): number {
    return (KIND_RANK[a.kind] ?? 2) - (KIND_RANK[b.kind] ?? 2);
  },
};

const readyAtComparator: NamedComparator = {
  id: 'readyAt',
  compare(a: TaskCandidate, b: TaskCandidate): number {
    return a.timing.readyAtMs - b.timing.readyAtMs;
  },
};

const chainComparator: NamedComparator = {
  id: 'chain',
  compare(a: TaskCandidate, b: TaskCandidate): number {
    const aChain = CHAIN_RANK[a.constraints.chain ?? 'before'] ?? 0;
    const bChain = CHAIN_RANK[b.constraints.chain ?? 'before'] ?? 0;
    return aChain - bChain;
  },
};

const durationComparator: NamedComparator = {
  id: 'duration',
  compare(a: TaskCandidate, b: TaskCandidate): number {
    return a.timing.durationMs - b.timing.durationMs;
  },
};

const slackComparator: NamedComparator = {
  id: 'slack',
  compare(a: TaskCandidate, b: TaskCandidate): number {
    const aSlack = taskDeadlineMs(a) - a.timing.durationMs;
    const bSlack = taskDeadlineMs(b) - b.timing.durationMs;
    return aSlack - bSlack;
  },
};

const arpComparator: NamedComparator = {
  id: 'arp',
  compare(a: TaskCandidate, b: TaskCandidate): number {
    return (b.value.arp ?? 0) - (a.value.arp ?? 0);
  },
};

export const lifetimeArpPolicy: PriorityPolicy = {
  id: 'lifetimeArp',
  comparators: [
    kindComparator,
    readyAtComparator,
    chainComparator,
    durationComparator,
    slackComparator,
    arpComparator,
  ],
};
