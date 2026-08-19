import { ArtifactTier } from '../../../src/artifacts/data';
import {
  makeArtifact,
  makeSnapshot,
  resetArtifactIds,
  type PersonaFixture,
} from '../artifactFactory';

resetArtifactIds(1000);

export const newUser: PersonaFixture = {
  id: 'newUser',
  label: 'New user — low tier, no sets',
  defaultEquipped: ['scion-of-the-light', 'mysterious-text'],
  snapshot: makeSnapshot([
    makeArtifact('scion-of-the-light', ArtifactTier.Rust, {
      equippedPosition: 1,
    }),
    makeArtifact('mysterious-text', ArtifactTier.Rust, { equippedPosition: 2 }),
  ]),
};

resetArtifactIds(2000);

const apotho = makeArtifact('bali-arches', ArtifactTier.Interstellar, {
  equippedPosition: 1,
});
const chai = makeArtifact('chai-stones', ArtifactTier.Interstellar, {
  equippedPosition: 2,
});
const pn295 = makeArtifact('pn295', ArtifactTier.Interstellar, {
  equippedPosition: 3,
});
const recycler = makeArtifact(
  'pn295-unstable-battery',
  ArtifactTier.Interstellar,
);
const fission = makeArtifact('sylphin-fission-blade', ArtifactTier.Interstellar);

export const midTwitchFocus: PersonaFixture = {
  id: 'midTwitchFocus',
  label: 'Mid Twitch focus — Apotho + Chai + Pn295 (regression persona)',
  defaultEquipped: ['bali-arches', 'chai-stones', 'pn295'],
  snapshot: makeSnapshot([apotho, chai, pn295, recycler, fission]),
};

export const midPartialCooldown: PersonaFixture = {
  id: 'midPartialCooldown',
  label: 'Mid Twitch — slots 2/3 locked, slot 1 free',
  defaultEquipped: ['bali-arches', 'chai-stones', 'pn295'],
  snapshot: makeSnapshot(
    [
      { ...apotho, instanceId: 2001, slotLocked: false },
      { ...chai, instanceId: 2002, slotLocked: true },
      { ...pn295, instanceId: 2003, slotLocked: true },
      { ...recycler, instanceId: 2004 },
      { ...fission, instanceId: 2005 },
    ],
    { slotLocks: { 2: true, 3: true } },
  ),
};

resetArtifactIds(3000);

export const midZorathian: PersonaFixture = {
  id: 'midZorathian',
  label: 'Mid Zorathian — All-ARP% owned, wearing Twitch set',
  defaultEquipped: ['bali-arches', 'chai-stones', 'pn295'],
  snapshot: makeSnapshot([
    makeArtifact('bali-arches', ArtifactTier.Interstellar, {
      equippedPosition: 1,
    }),
    makeArtifact('chai-stones', ArtifactTier.Interstellar, {
      equippedPosition: 2,
    }),
    makeArtifact('pn295', ArtifactTier.Interstellar, { equippedPosition: 3 }),
    makeArtifact('zorathian-cosmotheque', ArtifactTier.Gold),
    makeArtifact('flux', ArtifactTier.Interstellar),
    makeArtifact('herkow-plasma-chamber', ArtifactTier.Interstellar),
  ]),
};

resetArtifactIds(4000);

export const endgameHpc: PersonaFixture = {
  id: 'endgameHpc',
  label: 'Endgame HPC standing set',
  defaultEquipped: [
    'herkow-plasma-chamber',
    'chai-stones',
    'pn295',
  ],
  snapshot: makeSnapshot([
    makeArtifact('herkow-plasma-chamber', ArtifactTier.Interstellar, {
      equippedPosition: 1,
    }),
    makeArtifact('chai-stones', ArtifactTier.Interstellar, {
      equippedPosition: 2,
    }),
    makeArtifact('pn295', ArtifactTier.Interstellar, { equippedPosition: 3 }),
    makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar),
    makeArtifact('bali-arches', ArtifactTier.Interstellar),
    makeArtifact('sylphin-fission-blade', ArtifactTier.Interstellar),
  ]),
};

resetArtifactIds(5000);

export const endgameNoHpc: PersonaFixture = {
  id: 'endgameNoHpc',
  label: 'Endgame Pn295-first standing set',
  defaultEquipped: ['pn295', 'chai-stones', 'bali-arches'],
  snapshot: makeSnapshot([
    makeArtifact('pn295', ArtifactTier.Interstellar, { equippedPosition: 1 }),
    makeArtifact('chai-stones', ArtifactTier.Interstellar, {
      equippedPosition: 2,
    }),
    makeArtifact('bali-arches', ArtifactTier.Interstellar, {
      equippedPosition: 3,
    }),
    makeArtifact('pn295-unstable-battery', ArtifactTier.Interstellar),
    makeArtifact('sylphin-fission-blade', ArtifactTier.Interstellar),
    makeArtifact('zorathian-cosmotheque', ArtifactTier.Interstellar),
    makeArtifact('flux', ArtifactTier.Interstellar),
  ]),
};

export const ALL_PERSONAS: readonly PersonaFixture[] = [
  newUser,
  midTwitchFocus,
  midPartialCooldown,
  midZorathian,
  endgameHpc,
  endgameNoHpc,
];
