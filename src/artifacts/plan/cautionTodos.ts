import type { OptimizerResult } from '../optimizer';
import type { ActionTodo } from './types';
import { formatArpLossBreakdownLines } from './shared';

// ── Marketplace discount caution ───────────────────────────────────────

export function pushMarketplaceDiscountPriorityCaution(
  todos: ActionTodo[],
  result: OptimizerResult,
): void {
  const marketPriority = result.marketplaceDiscountPriority;
  if (!marketPriority?.pending || marketPriority.arpDelta <= 0) {
    return;
  }
  const lossReasons = formatArpLossBreakdownLines(
    (marketPriority.arpLossLines ?? []).filter((line) => line.delta > 0).slice(0, 5),
  ).map((text) => ({ text }));
  todos.push({
    kind: 'caution',
    tone: 'warn',
    text: `Marketplace discount prioritization: ~${String(marketPriority.arpDelta)} ARP left on the table vs ARP-optimal gear this lock`,
    reasons: [
      ...lossReasons,
      {
        text: 'Delay Steam Quests until after discount gear is on when possible; finish non-delayable dailies listed before the swap',
      },
    ],
  });
}
