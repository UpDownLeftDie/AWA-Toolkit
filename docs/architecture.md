# Architecture & Contributing

## Goal

**Maximize total lifetime ARP.** Every recommendation, ranking rule, and feature exists to increase the ARP a user earns over their entire account lifetime — not just today. When a change could reduce lifetime ARP even marginally, treat it as needing explicit review.

---

## Where things live

### Add an activity

`src/artifacts/activities/`

One file per activity (e.g. `watchTwitch.ts`). An activity exports a scorer that reads `SiteState` + `ArtifactOptimizerSettings` and returns a scored `ActivityResult` (ARP value, timing, cooldown window). Register it in `src/artifacts/activities/index.ts`. The optimizer picks up new activities automatically.

### Add a task provider

`src/artifacts/plan/providers/`

A provider is a pure function `(context: PlanContext) => TaskCandidate[]`. It reads from `PlanContext` (optimizer result, site state, achievements data, etc.) and returns ranked-ready task candidates. Add the new file, export it from `providers/index.ts`, then add it to the `PLAN_PROVIDERS` array in `src/artifacts/plan/buildActionPlan.ts`.

Task IDs must be unique within a provider run (e.g. `achievement:slug:0`). Set `value.arp` for ARP-bearing tasks; omit or set to `0` for non-ARP tasks. Use `constraints.chain` (`'before'` / `'equip'` / `'after'`) to position relative to the loadout swap step — `buildActionPlan` turns those into hard `before`/`after` edges against equip task ids.

### Add or change a priority policy

Two layers, both need updating for a new policy:

- **Planner layer** — `src/planner/policies/lifetimeArp.ts`: defines `NamedComparator` functions and assembles them into a `PriorityPolicy`. The sort key order is: `kind → readyAt → chain → duration → deadline slack → ARP`.
- **Artifact layer** — `src/artifacts/optimizer/policies.ts`: wraps the planner policy with a `loadoutObjective` (how to score a `ScoredCombo` for loadout selection). Add a new `ArtifactPriorityPolicy`, then register it in `resolveActivePolicy()`.

---

## How ranking works

`rank(candidates, policy)` in `src/planner/rank.ts`:

1. **Cautions** (`kind === 'caution'`) float to the top in input order — they are warnings, not steps.
2. **`pinFirst`** tasks (e.g. Start Battle Pass) sort before all non-cautions.
3. **Topological constraints** (`constraints.after` / `constraints.before`) enforce hard ordering using Kahn's algorithm. Cycles are detected with Tarjan's SCC and broken by falling back to comparator order.
4. **Policy comparators** break ties in declaration order (stable sort).

Each ranked task records a `RankDecision` trace (task id, rank, reasons). Enable it in the browser console with `window.__AWA_PLAN_TRACE__ = true`.

---

## How to run tests

```sh
pnpm test          # unit tests (vitest, ~3 400 cases)
pnpm test:sim      # month-long ARP simulation (slow; run before big optimizer changes)
pnpm lint          # ESLint + tsc --noEmit
```

Golden snapshot tests in `tests/audit/actionPlan.golden.test.ts` lock the action-plan output for key scenarios. Update them with `pnpm test -- --update-snapshots` after intentional changes.
