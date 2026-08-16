/**
Static artifact / set / fragment tables (community guides + live Showroom validation).
*/

export interface CreditLink {
  label: string;
  url: string;
}

export interface CreditSource {
  id: string;
  label: string;
  dateAccessed?: string;
  url: string;
  /**
  Extra deep links shown in the full credits line.
  */
  links?: readonly CreditLink[];
}

/**
Attribution sources for optimizer math / META guidance. Expand as needed.
*/
export const CREDIT_SOURCES: readonly CreditSource[] = [
  {
    id: 'megumin-tools',
    label: "Megumin's Tools",
    dateAccessed: '2026-08-10',
    url: 'https://docs.google.com/spreadsheets/d/1VCzq6Trwc9T_wEsvTANpL7yy8FaJ6psSsKYn4O4riw8/edit?usp=sharing',
    links: [
      {
        label: 'Artifact Upgrade C/P',
        url: 'https://docs.google.com/spreadsheets/d/1VCzq6Trwc9T_wEsvTANpL7yy8FaJ6psSsKYn4O4riw8/edit?gid=1046753957#gid=1046753957',
      },
      {
        label: 'ARP Calculator',
        url: 'https://docs.google.com/spreadsheets/d/1VCzq6Trwc9T_wEsvTANpL7yy8FaJ6psSsKYn4O4riw8/edit?gid=1289162159#gid=1289162159',
      },
    ],
  },
  {
    id: 'megumin-ucf-artifacts-info',
    label: '【Artifacts】Info',
    dateAccessed: '2026-08-06',
    url: 'https://www.alienwarearena.com/ucf/show/2167784',
  },
  {
    id: 'asce',
    label: 'ASCE',
    url: 'https://github.com/MarvashMagalli/ASCE',
  },
];

export enum ArtifactTier {
  Rust = 0,
  Bronze = 1,
  Silver = 2,
  Gold = 3,
  Platinum = 4,
  Interstellar = 5,
}

export const TIER_LABELS: Record<ArtifactTier, string> = {
  [ArtifactTier.Rust]: 'Rust',
  [ArtifactTier.Bronze]: 'Bronze',
  [ArtifactTier.Silver]: 'Silver',
  [ArtifactTier.Gold]: 'Gold',
  [ArtifactTier.Platinum]: 'Platinum',
  [ArtifactTier.Interstellar]: 'Interstellar',
};

/**
Fragment cost to upgrade *to* this tier from the previous one.
*/
export const FRAGMENT_COST_TO_TIER: Record<ArtifactTier, number> = {
  [ArtifactTier.Rust]: 0,
  [ArtifactTier.Bronze]: 2,
  [ArtifactTier.Silver]: 5,
  [ArtifactTier.Gold]: 10,
  [ArtifactTier.Platinum]: 16,
  [ArtifactTier.Interstellar]: 25,
};

export type ArtifactCategory =
  | 'Weapon'
  | 'Clothing'
  | 'Power'
  | 'Language'
  | 'Precious Gems'
  | 'Tech'
  | 'Knowledge'
  | 'Social'
  | 'Architecture';

export enum ArtifactEffectType {
  SteamQuests = 'SteamQuests',
  WatchTwitch = 'WatchTwitch',
  DailyCalendar = 'DailyCalendar',
  TimeOnSite = 'TimeOnSite',
  DiscordPoll = 'DiscordPoll',
  MarketDiscountPct = 'MarketDiscountPct',
  AllArpPct = 'AllArpPct',
  CommunityPlaytimePct = 'CommunityPlaytimePct',
  UsernameColor = 'UsernameColor',
  None = 'None',
}

export type EffectValue = number | string | undefined;

export interface ArtifactDefinition {
  id: string;
  category: ArtifactCategory;
  /**
  Display names aligned to ArtifactTier indices; undefined = that tier does not exist for this family.
  */
  tierNames: (string | undefined)[];
  /**
  Effect values aligned to ArtifactTier; undefined = tier unavailable.
  */
  effects: (EffectValue | undefined)[];
  effectType: ArtifactEffectType;
  /**
  Unit: 'flat' ARP, 'pct' (0.01 = 1%), or 'cosmetic'.
  */
  effectUnit: 'flat' | 'pct' | 'cosmetic';
}

export interface ArtifactSetDefinition {
  id: string;
  name: string;
  memberIds: string[];
  effects: {
    type: ArtifactEffectType;
    value: number;
    unit: 'flat' | 'pct' | 'cosmetic';
  }[];
  unconfirmed?: boolean;
}

export const ARTIFACTS: ArtifactDefinition[] = [
  {
    id: 'sylphin-fission-blade',
    category: 'Weapon',
    tierNames: [
      'Broken Sylphin Fission Blade',
      'Basic Sylphin Fission Blade',
      'Extended Sylphin Fission Blade',
      'Sylphin Fission Blade Mk1',
      'Sylphin Fission Blade Mk3',
      "Kylorf's Sylphin Fission Blade",
    ],
    effects: [1, 2, 4, 6, 8, 12],
    effectType: ArtifactEffectType.SteamQuests,
    effectUnit: 'flat',
  },
  {
    id: 'pn295',
    category: 'Tech',
    tierNames: [
      'Pn295 Unstable',
      'Pn295 Controlled',
      'Pn295 Fusion',
      'Pn295 Alloy',
      'Slyphin Battle Armor',
      'Pn295 Collapsed Star',
    ],
    // Live Showroom also uses "Pn295 Recycler" as Interstellar display — see aliases below.
    // Flat is treated as a higher daily Twitch cap at 1 ARP/min (Alloy +7 → ~22m).
    effects: [1, 2, 4, 7, 10, 15],
    effectType: ArtifactEffectType.WatchTwitch,
    effectUnit: 'flat',
  },
  {
    id: 'light-warping',
    category: 'Language',
    tierNames: [
      'Rudimentary Light Warping',
      'Simplistic Light Warping',
      'Phase Light Warping',
      'Bonded Phase Light Warping',
      'PLW Conduit RX13',
      'Light Warp Forerunners',
    ],
    effects: [-0.01, -0.03, -0.05, -0.08, -0.1, -0.15],
    effectType: ArtifactEffectType.MarketDiscountPct,
    effectUnit: 'pct',
  },
  {
    id: 'herkow-plasma-chamber',
    category: 'Power',
    tierNames: [
      undefined,
      undefined,
      undefined,
      'H`erkow Plasma Chamber',
      'H`erkow Control Center',
      'H`erkow Orb Reactor',
    ],
    effects: [undefined, undefined, undefined, 0.1, 0.15, 0.25],
    effectType: ArtifactEffectType.AllArpPct,
    effectUnit: 'pct',
  },
  {
    id: 'them',
    category: 'Power',
    tierNames: [
      '*** THEM ***',
      '*** THEM CONTAINED ***',
      '*** THEM ESCAPED ***',
      undefined,
      undefined,
      undefined,
    ],
    effects: [-0.2, -0.25, -0.25, undefined, undefined, undefined],
    effectType: ArtifactEffectType.AllArpPct,
    effectUnit: 'pct',
  },
  {
    id: 'herkow-warrior-script',
    category: 'Weapon',
    tierNames: [
      'H`erkow Warrior Script',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    effects: [1, undefined, undefined, undefined, undefined, undefined],
    effectType: ArtifactEffectType.SteamQuests,
    effectUnit: 'flat',
  },
  {
    id: 'scion-of-the-light',
    category: 'Tech',
    tierNames: [
      'Scion of the Light',
      'Scion of the Light: 2nd Sighting',
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    effects: [1, 2, undefined, undefined, undefined, undefined],
    effectType: ArtifactEffectType.WatchTwitch,
    effectUnit: 'flat',
  },
  {
    id: 'mysterious-text',
    category: 'Language',
    tierNames: [
      'Mysterious Text',
      'Mysterious Text Decipher',
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    effects: [-0.01, -0.02, undefined, undefined, undefined, undefined],
    effectType: ArtifactEffectType.MarketDiscountPct,
    effectUnit: 'pct',
  },
  {
    id: 'chai-stones',
    category: 'Precious Gems',
    tierNames: [
      'Chai Stones - Raw',
      'Chai Stones - Unprocessed',
      'Chai Stones - Processed',
      'The Stone of Cromcote`',
      'H`erkow Fertility Stone',
      'Chai Stone H`erkow Display',
    ],
    effects: [1, 2, 3, 4, 5, 6],
    effectType: ArtifactEffectType.DailyCalendar,
    effectUnit: 'flat',
  },
  {
    id: 'herkow-fertility-robes',
    category: 'Clothing',
    tierNames: [
      undefined,
      undefined,
      undefined,
      'H`erkow Fertility Robes',
      undefined,
      undefined,
    ],
    effects: [undefined, undefined, undefined, 'Pink', undefined, undefined],
    effectType: ArtifactEffectType.UsernameColor,
    effectUnit: 'cosmetic',
  },
  {
    id: 'pn295-unstable-battery',
    category: 'Weapon',
    tierNames: [
      'Pn 295 Unstable Battery',
      'Pn 295 Stable Battery',
      'Pn 295 Contained Battery',
      'Pn 295 Battery Amplifier',
      'Pn 295 Cruiser Class Battery Amplifier',
      'Pn 295 Recycler',
    ],
    effects: [2, 4, 6, 8, 10, 15],
    effectType: ArtifactEffectType.SteamQuests,
    effectUnit: 'flat',
  },
  {
    id: 'zorathian-cosmotheque',
    category: 'Knowledge',
    tierNames: [
      undefined,
      'Zorathian Cosmotheque',
      'Zorathian Data Mine',
      '5th Dimensional Data',
      'Crystalline Quantum Shelving',
      'Zorathian Library',
    ],
    effects: [undefined, 1, 2, 3, 4, 5],
    effectType: ArtifactEffectType.DiscordPoll,
    effectUnit: 'flat',
  },
  {
    id: 'flux',
    category: 'Social',
    tierNames: [
      'Flux',
      'Advanced Flux',
      'Spocot Board',
      'Spocot Flux Epoc',
      'Spocot Flux Final',
      'Spocot Flux Champion',
    ],
    effects: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5],
    effectType: ArtifactEffectType.CommunityPlaytimePct,
    effectUnit: 'pct',
  },
  {
    id: 'bali-arches',
    category: 'Architecture',
    tierNames: [
      undefined,
      "Ba'li Arches",
      'Northop Arches',
      'Golden Arches',
      'Apotho Arches',
      'Eye of the Night',
    ],
    effects: [undefined, 1, 2, 3, 4, 6],
    effectType: ArtifactEffectType.TimeOnSite,
    effectUnit: 'flat',
  },
  {
    id: 'gamers-wanted',
    category: 'Architecture',
    tierNames: [
      undefined,
      undefined,
      'Gamers Wanted',
      "They're Out There",
      'Defy Boundaries',
      'Rise',
    ],
    effects: [undefined, undefined, 1, 2, 3, 4],
    effectType: ArtifactEffectType.TimeOnSite,
    effectUnit: 'flat',
  },
  {
    id: 'omniversal-override',
    category: 'Language',
    tierNames: [
      undefined,
      undefined,
      'Omniversal Override',
      'Planetary Tranverser',
      'Dimensional Articulator',
      'Multi-Planar Transmuter',
    ],
    effects: [undefined, undefined, -0.02, -0.03, -0.04, -0.05],
    effectType: ArtifactEffectType.MarketDiscountPct,
    effectUnit: 'pct',
  },
  {
    id: 'the-black-rose',
    category: 'Clothing',
    tierNames: [
      'The Black Rose',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    effects: [
      'Dark Gray',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    effectType: ArtifactEffectType.UsernameColor,
    effectUnit: 'cosmetic',
  },
  {
    id: 'the-fractured-lilly',
    category: 'Precious Gems',
    tierNames: [
      'The Fractured Lilly',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    effects: [0, undefined, undefined, undefined, undefined, undefined],
    effectType: ArtifactEffectType.None,
    effectUnit: 'flat',
  },
  {
    id: 'the-veiled-thorn',
    category: 'Weapon',
    tierNames: [
      'The Veiled Thorn',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    effects: [0, undefined, undefined, undefined, undefined, undefined],
    effectType: ArtifactEffectType.None,
    effectUnit: 'flat',
  },
  {
    id: 'audio-archive-stone',
    category: 'Clothing',
    tierNames: [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'Audio Archive Stone',
    ],
    effects: [undefined, undefined, undefined, undefined, undefined, 'Tomato'],
    effectType: ArtifactEffectType.UsernameColor,
    effectUnit: 'cosmetic',
  },
];

/**
Extra live display names that don't match the guide's tier-name list exactly.
*/
const TIER_NAME_ALIASES: Record<string, { id: string; tier: ArtifactTier }> = {
  // Live Showroom sometimes drops the space after "Pn"
  'Pn295 Recycler': {
    id: 'pn295-unstable-battery',
    tier: ArtifactTier.Interstellar,
  },
  // Megumin guide spelling uses an apostrophe; Showroom uses a backtick
  "H'erkow Warrior Script": {
    id: 'herkow-warrior-script',
    tier: ArtifactTier.Rust,
  },
};

export const ARTIFACT_SETS: ArtifactSetDefinition[] = [
  {
    id: 'first-contact',
    name: 'First Contact',
    memberIds: ['sylphin-fission-blade', 'pn295', 'light-warping'],
    effects: [
      { type: ArtifactEffectType.DailyCalendar, value: 1, unit: 'flat' },
      { type: ArtifactEffectType.UsernameColor, value: 1, unit: 'cosmetic' },
    ],
  },
  {
    id: 'stanley-excavation',
    name: 'The Stanley Excavation',
    memberIds: [
      'chai-stones',
      'herkow-fertility-robes',
      'pn295-unstable-battery',
    ],
    effects: [
      { type: ArtifactEffectType.SteamQuests, value: 5, unit: 'flat' },
      { type: ArtifactEffectType.MarketDiscountPct, value: -0.15, unit: 'pct' },
    ],
  },
  {
    id: 'zorathian-renaissance',
    name: 'Zorathian Renaissance',
    memberIds: ['zorathian-cosmotheque', 'flux', 'bali-arches'],
    effects: [
      { type: ArtifactEffectType.AllArpPct, value: 0.1, unit: 'pct' },
      { type: ArtifactEffectType.UsernameColor, value: 1, unit: 'cosmetic' },
    ],
  },
  {
    id: 'braxtine-garden',
    name: 'Braxtine Garden',
    // This set is an April Fools joke, and likely unobtainable.
    memberIds: ['the-black-rose', 'the-crimsom-t', 'the-nebula-c'],
    effects: [
      { type: ArtifactEffectType.AllArpPct, value: 5, unit: 'pct' },
      { type: ArtifactEffectType.TimeOnSite, value: 100, unit: 'flat' },
    ],
  },
];

/**
 * Base ARP rates for a single 24h swap window (artifacts can change once per day).
 * Weeklies are included only when that activity is still unfinished this period.
 */
export const BASE_ACTIVITY = {
  /**
  Days scored per daily activity when still available.
  */
  days: 1,
  timeOnSiteBasePerDay: 5,
  /**
  Unbuffed daily Watch Twitch ARP cap (Quest Setup / terms: "up to 15 ARP
  every day"). Equipped Watch Twitch flats raise this cap; tick rate stays
  1 ARP/min so remaining sit = (cap + flat − earned) minutes.
  */
  watchTwitchBasePerDay: 15,
  /**
  Per-week Steam Quest ARP amounts (easy + hard + hard).
  */
  steamQuestBases: [15, 25, 25] as const,
  discordPollBase: 5,
  /**
  Typical Discord polls still claimable in a pending week (best-effort).
  Guide math is 5 ARP × 5 weekdays × 4 weeks; post hour is not in the guides.
  */
  discordPollsWhenPending: 2,
  /**
  Observed weekday Discord poll post time (16:00 UTC / 9:00 PDT). Cutoff for
  the previous poll is unconfirmed — we treat the next post as the conservative
  close.
  */
  discordPollPostHourUtc: 16,
  dailyQuestBase: 7,
  weekendQuestBase: 5,
  /**
  Average daily calendar base ARP (monthly guide total / 30).
  */
  dailyCalendarBasePerDay: 5,
  /**
  Steam Community Event reward lumps (guide: only AllArpPct boosts these).
  Used as a fallback estimate when a live event page has not been scraped yet.
  */
  steamCommunityEventReward: 20,
} as const;

/**
Typical monthly uses of a category flat, for upgrade planning (not the 24h
swap window). Megumin: dailies ×30, Steam quests 3×4 weeks, Discord 5×4 weekdays.
*/
export const MONTHLY_CATEGORY_USES: Partial<
  Record<ArtifactEffectType, number>
> = {
  [ArtifactEffectType.WatchTwitch]: 30,
  [ArtifactEffectType.DailyCalendar]: 30,
  [ArtifactEffectType.TimeOnSite]: 30,
  [ArtifactEffectType.SteamQuests]: 12,
  [ArtifactEffectType.DiscordPoll]: 20,
};

/**
Rough monthly ARP pool used to value All-ARP% upgrades (HPC).
*/
export const MONTHLY_ARP_FOR_PCT = 1800;

/**
Megumin end-game upgrade order when HPC is owned.
*/
export const END_GAME_HPC_UPGRADE_ORDER = [
  'herkow-plasma-chamber',
  'pn295',
  'chai-stones',
  'pn295-unstable-battery',
  'bali-arches',
  'sylphin-fission-blade',
  'zorathian-cosmotheque',
  'scion-of-the-light',
] as const;

/**
Megumin end-game upgrade order without HPC (Pn295 Watch Twitch first).
*/
export const END_GAME_NO_HPC_UPGRADE_ORDER = [
  'pn295',
  'chai-stones',
  'pn295-unstable-battery',
  'bali-arches',
  'sylphin-fission-blade',
  'zorathian-cosmotheque',
  'scion-of-the-light',
] as const;

/**
New-game: finish the Zorathian set, then Scion. Other owned ARP pieces follow.
*/
export const NEW_GAME_UPGRADE_ORDER = [
  'bali-arches',
  'zorathian-cosmotheque',
  'flux',
  'scion-of-the-light',
] as const;

export function upgradeFocusOrder(
  ownedFamilyIds: ReadonlySet<string>,
): readonly string[] {
  if (ownedFamilyIds.has('herkow-plasma-chamber')) {
    return END_GAME_HPC_UPGRADE_ORDER;
  }
  if (ownedFamilyIds.has('pn295')) {
    return END_GAME_NO_HPC_UPGRADE_ORDER;
  }
  return NEW_GAME_UPGRADE_ORDER;
}

/**
Megumin ❌ Swap standing 3-set (wear all month). Fill order covers missing pieces.
*/
export const END_GAME_HPC_STANDING = [
  'herkow-plasma-chamber',
  'chai-stones',
  'pn295',
] as const;

export const END_GAME_NO_HPC_STANDING = [
  'pn295',
  'chai-stones',
  'bali-arches',
] as const;

export const NEW_GAME_STANDING = [
  'bali-arches',
  'zorathian-cosmotheque',
  'flux',
] as const;

export function monthlyMetaStandingFamilies(
  ownedFamilyIds: ReadonlySet<string>,
): {
  standing: readonly string[];
  fillOrder: readonly string[];
} {
  if (ownedFamilyIds.has('herkow-plasma-chamber')) {
    return {
      standing: END_GAME_HPC_STANDING,
      fillOrder: END_GAME_HPC_UPGRADE_ORDER,
    };
  }
  if (ownedFamilyIds.has('pn295')) {
    return {
      standing: END_GAME_NO_HPC_STANDING,
      fillOrder: END_GAME_NO_HPC_UPGRADE_ORDER,
    };
  }
  return {
    standing: NEW_GAME_STANDING,
    fillOrder: NEW_GAME_UPGRADE_ORDER,
  };
}

export function getArtifactById(id: string): ArtifactDefinition | undefined {
  return ARTIFACTS.find((a) => a.id === id);
}

export function resolveArtifactByDisplayName(
  displayName: string,
): { definition: ArtifactDefinition; tier: ArtifactTier } | undefined {
  const alias = TIER_NAME_ALIASES[displayName];
  if (alias) {
    const definition = getArtifactById(alias.id);
    if (definition) {
      return { definition, tier: alias.tier };
    }
  }

  for (const definition of ARTIFACTS) {
    const index = definition.tierNames.findIndex(
      (name) => name?.toLowerCase() === displayName.toLowerCase(),
    );
    if (index !== -1) {
      return { definition, tier: index as ArtifactTier };
    }
  }

  // Fuzzy: strip backticks / fancy apostrophes
  const normalized = normalizeName(displayName);
  for (const definition of ARTIFACTS) {
    const index = definition.tierNames.findIndex(
      (name) => name !== undefined && normalizeName(name) === normalized,
    );
    if (index !== -1) {
      return { definition, tier: index as ArtifactTier };
    }
  }

  return undefined;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[`'’]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function getNumericEffect(
  definition: ArtifactDefinition,
  tier: ArtifactTier,
): number {
  if (definition.effectUnit === 'cosmetic') {
    return 0;
  }
  const value = definition.effects[tier];
  return typeof value === 'number' ? value : 0;
}

export function fragmentCostToUpgradeFrom(
  tier: ArtifactTier,
): number | undefined {
  if (tier >= ArtifactTier.Interstellar) {
    return undefined;
  }
  return FRAGMENT_COST_TO_TIER[(tier + 1) as ArtifactTier];
}

export function displayNameFor(
  definition: ArtifactDefinition,
  tier: ArtifactTier,
): string {
  return definition.tierNames[tier] ?? definition.id;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function utcAtHour(date: Date, hour: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      hour,
      0,
      0,
      0,
    ),
  );
}

export function isUtcWeekday(date: Date): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * Next weekday 16:00 UTC poll post strictly after `now`.
 */
export function nextDiscordPollPostAt(now = new Date()): Date {
  for (let offset = 0; offset <= 7; offset += 1) {
    const post = utcAtHour(
      new Date(now.getTime() + offset * MS_PER_DAY),
      BASE_ACTIVITY.discordPollPostHourUtc,
    );
    if (isUtcWeekday(post) && post.getTime() > now.getTime()) {
      return post;
    }
  }
  return utcAtHour(now, BASE_ACTIVITY.discordPollPostHourUtc);
}

/**
 * Most recent weekday 16:00 UTC poll post at or before `now`.
 */
export function lastDiscordPollPostAt(now = new Date()): Date {
  for (let offset = 0; offset <= 7; offset += 1) {
    const post = utcAtHour(
      new Date(now.getTime() - offset * MS_PER_DAY),
      BASE_ACTIVITY.discordPollPostHourUtc,
    );
    if (isUtcWeekday(post) && post.getTime() <= now.getTime()) {
      return post;
    }
  }
  return utcAtHour(now, BASE_ACTIVITY.discordPollPostHourUtc);
}

export function msUntilNextDiscordPollPost(now = new Date()): number {
  return Math.max(0, nextDiscordPollPostAt(now).getTime() - now.getTime());
}
