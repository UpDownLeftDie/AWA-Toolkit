import {
  ArtifactTier,
  displayNameFor,
  getArtifactById,
} from '../../src/artifacts/data';
import type {
  ArtifactSnapshot,
  ArtifactSlotIndex,
  OwnedArtifact,
} from '../../src/artifacts/scraper';

let nextInstanceId = 1000;

export function resetArtifactIds(start = 1000): void {
  nextInstanceId = start;
}

export function makeArtifact(
  familyId: string,
  tier: ArtifactTier,
  options: {
    instanceId?: number;
    equippedPosition?: ArtifactSlotIndex;
    slotLocked?: boolean;
  } = {},
): OwnedArtifact {
  const definition = getArtifactById(familyId);
  if (!definition) {
    throw new Error(`Unknown artifact family: ${familyId}`);
  }
  const instanceId = options.instanceId ?? nextInstanceId++;
  const artifact: OwnedArtifact = {
    instanceId,
    familyId,
    displayName: displayNameFor(definition, tier),
    tier,
    category: definition.category,
    maxLevel: tier >= ArtifactTier.Interstellar,
    perkDescription: '',
  };
  if (options.equippedPosition !== undefined) {
    artifact.equippedPosition = options.equippedPosition;
  }
  if (options.slotLocked !== undefined) {
    artifact.slotLocked = options.slotLocked;
  }
  return artifact;
}

export function makeSnapshot(
  artifacts: OwnedArtifact[],
  options: {
    fragments?: number;
    slotLocks?: Partial<Record<ArtifactSlotIndex, boolean>>;
    username?: string;
  } = {},
): ArtifactSnapshot {
  const snapshot: ArtifactSnapshot = {
    scrapedAt: new Date(0).toISOString(),
    username: options.username ?? 'test-user',
    fragments: options.fragments ?? 0,
    artifacts,
  };
  if (options.slotLocks) {
    snapshot.slotLocks = options.slotLocks;
  }
  return snapshot;
}

export interface PersonaFixture {
  id: string;
  label: string;
  snapshot: ArtifactSnapshot;
  defaultEquipped: readonly string[];
}
