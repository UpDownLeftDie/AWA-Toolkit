// Thin re-export barrel — keeps `from './helpers'` working everywhere.
// Domain logic lives in the focused modules (shared, activityTodos, etc.).

// ── shared.ts ──────────────────────────────────────────────────────────
export {
  actionUrgency,
  type ActivityPhase,
  activityWindowArp,
  bonusForActivityPhase,
  comboBonusForActivity,
  type DiscordPollSlot,
  formatArpLossBreakdownLines,
  formatCommunityEta,
  hasAnySlotOnCooldown,
  isSameLoadout,
  type LoadoutChangePlan,
  maxSlotCooldownMs,
  planLoadoutChanges,
  type PlannedWear,
  plannedWearForResets,
  type ActivityKey,
} from './shared';

// ── activityTodos.ts ───────────────────────────────────────────────────
export { buildSequencedActivityTodos } from './activityTodos';

// ── battlePassTodos.ts ─────────────────────────────────────────────────
export {
  battlePassAllArpEquipTodo,
  battlePassAllArpSchedule,
  pushAllArpGuardTodos,
  pushBattlePassTodo,
  pushScheduledAllArpTodos,
  pushStartBattlePassTodo,
} from './battlePassTodos';

// ── equipTodos.ts ──────────────────────────────────────────────────────
export {
  buildEquipTodo,
  buildSwapEquipTodos,
  collectEquipReasons,
  deferredSteamTodo,
  pushEquipPlanTodos,
  shouldFoldDeferredSteam,
  upgradeTodosFor,
} from './equipTodos';

// ── discordTodos.ts ────────────────────────────────────────────────────
export {
  buildDiscordPollAction,
  discordTodoForSlot,
} from './discordTodos';

// ── cautionTodos.ts ────────────────────────────────────────────────────
export { pushMarketplaceDiscountPriorityCaution } from './cautionTodos';
