import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../core/time';
import {
  activeSets,
  isSameLoadout as contextIsSameLoadout,
} from './optimizer/context';
import type { OptimizerResult, ScoredCombo } from './optimizer/types';
import type { OwnedArtifact } from './scraper';

export function formatMs(ms: number): string {
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  const mins = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  if (hours > 0 && mins > 0) {
    return `${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return mins > 0 ? `${mins}m` : '<1m';
}

/**
Daily AWA activities (calendar, Twitch, etc.) reset at 00:00 UTC.
*/
export function msUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(0, next - now.getTime());
}

export function utcResetDeadlineLabel(now = new Date()): string {
  return `${formatMs(msUntilUtcMidnight(now))} left`;
}

/**
Worn loadouts and planned display copies (every piece has a slot) stay in
slot 1–3 order. Other lists stay alphabetical.
*/
export function sortArtifactsForDisplay<
  T extends { displayName: string; equippedPosition?: number },
>(artifacts: T[]): T[] {
  const isWornLoadout = artifacts.every(
    (artifact) => artifact.equippedPosition !== undefined,
  );
  if (isWornLoadout) {
    return artifacts.toSorted(
      (left, right) =>
        (left.equippedPosition ?? 0) - (right.equippedPosition ?? 0),
    );
  }
  return artifacts.toSorted((left, right) =>
    left.displayName.localeCompare(right.displayName, undefined, {
      sensitivity: 'base',
    }),
  );
}

export function artifactsForDisplay(
  combo: Pick<ScoredCombo, 'artifacts' | 'displayArtifacts'>,
): ScoredCombo['artifacts'] {
  return combo.displayArtifacts ?? sortArtifactsForDisplay(combo.artifacts);
}

export function loadoutLabel(
  artifacts: { displayName: string; equippedPosition?: number }[] | undefined,
): string {
  return !artifacts || artifacts.length === 0
    ? '—'
    : sortArtifactsForDisplay(artifacts)
        .map((artifact) => artifact.displayName)
        .join(' + ');
}

export function comboLabel(result: OptimizerResult['best']): string {
  return result ? loadoutLabel(artifactsForDisplay(result)) : '—';
}

export function loadoutSetNames(
  artifacts: { familyId: string }[] | undefined,
): string[] {
  return !artifacts || artifacts.length === 0
    ? []
    : activeSets(artifacts.map((artifact) => artifact.familyId)).map(
        (set) => set.name,
      );
}

/**
Loadout equality for optional/partial arrays (false when either side is empty).
Delegates set-equality to optimizer/context.
*/
export function isSameLoadout(
  left: { instanceId: number }[] | undefined,
  right: { instanceId: number }[] | undefined,
): boolean {
  if (!left || !right || left.length === 0 || right.length === 0) {
    return false;
  }
  return contextIsSameLoadout(
    left as OwnedArtifact[],
    right as OwnedArtifact[],
  );
}
