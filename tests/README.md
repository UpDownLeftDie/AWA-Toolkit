# Optimizer tests

Vitest harness for the artifact optimizer: persona fixtures, month scenarios, invariant audits, and an optional lifetime-ARP simulator.

## Commands

| Script | What runs |
|--------|-----------|
| `pnpm test` | Unit tests + full audit grid (personas × scenarios × UTC time grid). Intended for CI. |
| `pnpm test:sim` | 30-day lifetime-ARP simulator with oracle comparison. Local only — slower. |

## Layout

```
tests/
  fixtures/     Personas, month scenarios, UTC time grid
  audit/        Invariant rules + optimizer.audit.test.ts
  unit/         wearWindow, steamScoring, allArpLock
  sim/          Day-by-day monthSimulator (pnpm test:sim)
```

## Personas

Six inventory snapshots from `tests/fixtures/personas/`:

- **newUser** — low tier, no sets
- **midTwitchFocus** — regression loadout (Apotho + Chai + Pn295; owns Recycler/Fission unequipped)
- **midPartialCooldown** — slots 2/3 locked
- **midZorathian** — All-ARP% owned, wearing Twitch set
- **endgameHpc** / **endgameNoHpc** — Megumin standing sets

## Scenarios

Four month templates under `tests/fixtures/scenarios/`:

- **baseline** — no battle pass or community event
- **battlePassOnly** — claimable boosts, season ends mid-month
- **communityOnly** — ASCE-style milestones + hour samples
- **both** — battle pass + community event

Scenarios are functions `(dayOffset, nowMs) => SiteState` anchored to **2026-08-01 UTC**.

## Deterministic time

`OptimizerContext.nowMs` is injected via `buildContext(..., nowMs)` so scoring and search never depend on the real clock in tests.

## Regression cases

Named tests in `optimizer.audit.test.ts`:

1. `midTwitchFocus` + steam week complete → no Recycler/Fission 24h pick; lock-window ARP not ~180+
2. `midZorathian` + 10 ARP community lump + slot cooldown → no `deferredAllArp`
3. `midPartialCooldown` — partial equip OK, no steam-for-dailies trade

## Month simulator

`pnpm test:sim` steps **30 UTC days** with:

- **24h slot cooldowns** on both guided and oracle paths (`slotCooldowns` + `comboEquipWaitMs`)
- **Daily ARP** from the actually equipped loadout (flats + All-ARP%)
- **Community milestones** that progress ~3k community hours/day; payout = lump × `(1 + All-ARP%)` on whatever is equipped when gates clear
- **Battle pass** claim ARP = `readyToClaimArp × (1 + All-ARP%)` when the strategy claims on All-ARP%

| Path | Behavior |
|------|----------|
| **Guided** | Follows `buildActionPlan` equip steps when `readyAtMs === 0`; claims BP when the plan says so |
| **Oracle** | Same cooldown rules; swaps to All-ARP% before community gates / deferred All-ARP%; claims BP on All-ARP%; otherwise equips `best` when slots allow |

Guided should not trail the oracle by more than **10%** (action-plan sequencing vs perfect lump timing). Failures include per-ledger breakdowns.

### Community gate regression

`communityTenArpLump` (149.5k/150k gate, 10 ARP lump) asserts the **guided** path earns the same community ledger as the **oracle** — i.e. All-ARP% is on before the gate clears, not after. This catches action-plan timing bugs (e.g. equip todos missing `loadout`, or swapping back to flats before the award).

Not wired into CI v1 due to runtime.
