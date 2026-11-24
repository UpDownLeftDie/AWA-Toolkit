import type {
  PriorityPolicy,
  RankDecision,
  RankResult,
  TaskCandidate,
} from './types';

function findDecidingComparator(
  task: TaskCandidate,
  previous: TaskCandidate | undefined,
  comparators: PriorityPolicy['comparators'],
): string | undefined {
  if (
    previous === undefined ||
    previous.kind === 'caution' ||
    previous.constraints.pinFirst === true
  ) {
    return undefined;
  }
  for (const comparator of comparators) {
    if (comparator.compare(task, previous) !== 0) {
      return comparator.id;
    }
  }
  return undefined;
}

function traceReasons(
  task: TaskCandidate,
  index: number,
  ordered: TaskCandidate[],
  comparators: PriorityPolicy['comparators'],
  constraintReasons: Map<string, string[]>,
): string[] {
  if (task.kind === 'caution') {
    return ['kind:caution'];
  }

  const reasons: string[] = [];
  if (task.constraints.pinFirst === true) {
    reasons.push('pinFirst');
  }
  reasons.push(
    `kind:${task.kind}`,
    `readyAt:${String(task.timing.readyAtMs)}`,
  );
  if (task.constraints.chain !== undefined) {
    reasons.push(`chain:${task.constraints.chain}`);
  }
  if (task.value.arp !== undefined) {
    reasons.push(`arp:${String(task.value.arp)}`);
  }

  const constraintTrace = constraintReasons.get(task.id);
  if (constraintTrace !== undefined) {
    reasons.push(...constraintTrace);
  }

  if (index > 0) {
    const decidedBy = findDecidingComparator(task, ordered[index - 1], comparators);
    if (decidedBy !== undefined) {
      reasons.push(`decidedBy:${decidedBy}`);
    }
  }

  return reasons;
}

function buildTrace(
  ordered: TaskCandidate[],
  comparators: PriorityPolicy['comparators'],
  constraintReasons: Map<string, string[]>,
): RankDecision[] {
  return ordered.map((task, index) => ({
    taskId: task.id,
    rank: index,
    reasons: traceReasons(task, index, ordered, comparators, constraintReasons),
  }));
}

// ── Topological constraint ordering ─────────────────────────────────────

type TaskComparator = (a: TaskCandidate, b: TaskCandidate) => number;

function ensurePredecessorSet(
  map: Map<string, Set<string>>,
  id: string,
): Set<string> {
  let set = map.get(id);
  if (!set) {
    set = new Set();
    map.set(id, set);
  }
  return set;
}

/**
Build adjacency from `constraints.after` / `constraints.before`.
Returns a map: taskId → set of task ids that must come before it.
*/
function buildPrecedenceEdges(
  tasks: TaskCandidate[],
): Map<string, Set<string>> {
  const idSet = new Set(tasks.map((t) => t.id));
  const predecessors = new Map<string, Set<string>>();

  for (const task of tasks) {
    const afterIds = task.constraints.after ?? [];
    for (const dependencyId of afterIds) {
      if (!idSet.has(dependencyId)) {
        continue;
      }
      ensurePredecessorSet(predecessors, task.id).add(dependencyId);
    }

    const beforeIds = task.constraints.before ?? [];
    for (const followerId of beforeIds) {
      if (!idSet.has(followerId)) {
        continue;
      }
      ensurePredecessorSet(predecessors, followerId).add(task.id);
    }
  }

  return predecessors;
}

function hasAnyConstraintEdge(tasks: TaskCandidate[]): boolean {
  return tasks.some(
    (task) =>
      (task.constraints.after !== undefined && task.constraints.after.length > 0) ||
      (task.constraints.before !== undefined && task.constraints.before.length > 0),
  );
}

function buildSuccessorMap(
  tasks: TaskCandidate[],
  edges: Map<string, Set<string>>,
): Map<string, string[]> {
  const successors = new Map<string, string[]>();
  for (const task of tasks) {
    successors.set(task.id, []);
  }
  for (const [dependentId, predecessorSet] of edges) {
    for (const predecessorId of predecessorSet) {
      successors.get(predecessorId)?.push(dependentId);
    }
  }
  return successors;
}

/**
Detect strongly-connected components (cycles) using Tarjan's algorithm.
Returns arrays of task ids per SCC with size > 1.
*/
function findCycles(
  tasks: TaskCandidate[],
  edges: Map<string, Set<string>>,
): string[][] {
  const successors = buildSuccessorMap(tasks, edges);

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function visit(nodeId: string): void {
    indices.set(nodeId, nextIndex);
    lowlinks.set(nodeId, nextIndex);
    nextIndex++;
    stack.push(nodeId);
    onStack.add(nodeId);

    const neighbors = successors.get(nodeId) ?? [];
    for (const neighbor of neighbors) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        lowlinks.set(
          nodeId,
          Math.min(lowlinks.get(nodeId) ?? 0, lowlinks.get(neighbor) ?? 0),
        );
      } else if (onStack.has(neighbor)) {
        lowlinks.set(
          nodeId,
          Math.min(lowlinks.get(nodeId) ?? 0, indices.get(neighbor) ?? 0),
        );
      }
    }

    if (lowlinks.get(nodeId) !== indices.get(nodeId)) {
      return;
    }

    const component: string[] = [];
    let popped: string | undefined;
    do {
      popped = stack.pop();
      if (popped === undefined) {
        break;
      }
      onStack.delete(popped);
      component.push(popped);
    } while (popped !== nodeId);

    if (component.length > 1) {
      components.push(component);
    }
  }

  for (const task of tasks) {
    if (!indices.has(task.id)) {
      visit(task.id);
    }
  }
  return components;
}

function computeEffectiveInDegrees(
  tasks: TaskCandidate[],
  edges: Map<string, Set<string>>,
  cycleMembers: Set<string>,
): Map<string, number> {
  const inDegree = new Map<string, number>();
  for (const task of tasks) {
    const predecessorSet = edges.get(task.id);
    if (!predecessorSet) {
      inDegree.set(task.id, 0);
      continue;
    }
    let count = 0;
    for (const predecessorId of predecessorSet) {
      const isIntraCycle = cycleMembers.has(task.id) && cycleMembers.has(predecessorId);
      if (!isIntraCycle) {
        count++;
      }
    }
    inDegree.set(task.id, count);
  }
  return inDegree;
}

function buildEffectiveSuccessors(
  tasks: TaskCandidate[],
  edges: Map<string, Set<string>>,
  cycleMembers: Set<string>,
): Map<string, string[]> {
  const effectiveSuccessors = new Map<string, string[]>();
  for (const task of tasks) {
    effectiveSuccessors.set(task.id, []);
  }
  for (const [dependentId, predecessorSet] of edges) {
    for (const predecessorId of predecessorSet) {
      const isIntraCycle = cycleMembers.has(dependentId) && cycleMembers.has(predecessorId);
      if (!isIntraCycle) {
        effectiveSuccessors.get(predecessorId)?.push(dependentId);
      }
    }
  }
  return effectiveSuccessors;
}

function insertSorted(
  ready: TaskCandidate[],
  task: TaskCandidate,
  compare: TaskComparator,
): void {
  for (let index = 0; index < ready.length; index++) {
    const current = ready[index];
    if (current !== undefined && compare(task, current) < 0) {
      ready.splice(index, 0, task);
      return;
    }
  }
  ready.push(task);
}

/**
Kahn's topological sort using comparator as tie-break for ready nodes.
Cycle members (from `cycleMembers`) are treated as having no constraint edges
among themselves — they are sorted purely by comparator.
*/
function topoSort(
  tasks: TaskCandidate[],
  edges: Map<string, Set<string>>,
  compare: TaskComparator,
  cycleMembers: Set<string>,
): TaskCandidate[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = computeEffectiveInDegrees(tasks, edges, cycleMembers);
  const effectiveSuccessors = buildEffectiveSuccessors(tasks, edges, cycleMembers);

  const result: TaskCandidate[] = [];
  const ready = tasks
    .filter((t) => (inDegree.get(t.id) ?? 0) === 0)
    .toSorted(compare);

  while (ready.length > 0) {
    const task = ready.shift();
    if (task === undefined) {
      break;
    }
    result.push(task);
    const successorIds = effectiveSuccessors.get(task.id) ?? [];
    for (const successorId of successorIds) {
      const degree = (inDegree.get(successorId) ?? 1) - 1;
      inDegree.set(successorId, degree);
      if (degree !== 0) {
        continue;
      }
      const successorTask = taskMap.get(successorId);
      if (successorTask !== undefined) {
        insertSorted(ready, successorTask, compare);
      }
    }
  }

  return result;
}

function recordConstraintTraceReasons(
  edges: Map<string, Set<string>>,
  cycleMembers: Set<string>,
  constraintReasons: Map<string, string[]>,
): void {
  for (const [taskId, predecessorSet] of edges) {
    if (predecessorSet.size === 0 || cycleMembers.has(taskId)) {
      continue;
    }
    const reasons = constraintReasons.get(taskId) ?? [];
    for (const predecessorId of predecessorSet) {
      reasons.push(`after:${predecessorId}`);
    }
    constraintReasons.set(taskId, reasons);
  }
}

/**
Apply topological constraint ordering then fall back to comparator tie-break.
Exported for testing.
*/
export function applyConstraintOrder(
  tasks: TaskCandidate[],
  compare: TaskComparator,
): { ordered: TaskCandidate[]; constraintReasons: Map<string, string[]> } {
  const constraintReasons = new Map<string, string[]>();

  if (!hasAnyConstraintEdge(tasks)) {
    return { ordered: tasks.toSorted(compare), constraintReasons };
  }

  const edges = buildPrecedenceEdges(tasks);
  const cycles = findCycles(tasks, edges);
  const cycleMembers = new Set<string>();

  for (const cycle of cycles) {
    for (const id of cycle) {
      cycleMembers.add(id);
      const reasons = constraintReasons.get(id) ?? [];
      reasons.push('constraintCycle');
      constraintReasons.set(id, reasons);
    }
  }

  recordConstraintTraceReasons(edges, cycleMembers, constraintReasons);
  const ordered = topoSort(tasks, edges, compare, cycleMembers);
  return { ordered, constraintReasons };
}

/**
Sort task candidates according to a priority policy.

1. Cautions (kind === 'caution') stay pinned above in input order.
2. Among non-cautions: pinFirst tasks sort before all others.
3. Topological constraints (after/before) enforce hard ordering.
4. Policy comparators break ties in declaration order (stable sort).
*/
export function rank(
  tasks: TaskCandidate[],
  policy: PriorityPolicy,
): RankResult {
  const cautions = tasks.filter((task) => task.kind === 'caution');
  const nonCautions = tasks.filter((task) => task.kind !== 'caution');

  const pinned = nonCautions.filter((t) => t.constraints.pinFirst === true);
  const rest = nonCautions.filter((t) => t.constraints.pinFirst !== true);

  const compare = (a: TaskCandidate, b: TaskCandidate): number => {
    for (const comparator of policy.comparators) {
      const delta = comparator.compare(a, b);
      if (delta !== 0) {
        return delta;
      }
    }
    return 0;
  };

  const sortedPinned = pinned.toSorted(compare);
  const { ordered: sortedRest, constraintReasons } = applyConstraintOrder(
    rest,
    compare,
  );

  const ordered = [...cautions, ...sortedPinned, ...sortedRest];
  const trace = buildTrace(ordered, policy.comparators, constraintReasons);
  return { ordered, trace };
}

export function debugRankTrace(result: RankResult): void {
  if (
    (globalThis as Record<string, unknown>).__AWA_PLAN_TRACE__ !== true
  ) {
    return;
  }
  for (const decision of result.trace) {
    console.debug(
      `[plan] #${String(decision.rank)} ${decision.taskId}: ${decision.reasons.join(', ')}`,
    );
  }
}
