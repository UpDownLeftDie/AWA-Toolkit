export type AchievementCategory =
  | 'avatar'
  | 'profile'
  | 'visitPages'
  | 'watchVideos'
  | 'readArticles'
  | 'gameVault'
  | 'relay'
  | 'discord'
  | 'steamQuests'
  | 'steamHours'
  | 'twitchNexus'
  | 'twitchHive'
  | 'calendarBorders'
  | 'streaks'
  | 'years'
  | 'tiers'
  | 'communityEvents'
  | 'communityHours'
  | 'artifacts'
  | 'spendArp'
  | 'fragments'
  | 'verified';

/**
 * Background GETs that can count toward visit/read/enter achievements.
 * Off by default — each key has its own switch.
 */
export const ACHIEVEMENT_AUTOMATION_KEYS = [
  'visitPages',
  'profileCosmetics',
  'watchVideos',
  'readArticles',
  'gameVault',
] as const;

export type AchievementAutomationKey =
  (typeof ACHIEVEMENT_AUTOMATION_KEYS)[number];

export const ACHIEVEMENT_AUTOMATION_COPY: Record<
  AchievementAutomationKey,
  { title: string; hint: string }
> = {
  visitPages: {
    title: 'Visit FAQ & Hive',
    hint: 'Loads the FAQ and Hive pages in the background when those visits are still unearned.',
  },
  profileCosmetics: {
    title: 'Profile & border changes',
    hint: 'Once per UTC day: save About Me if needed, rotate border and avatar via the avatar save API.',
  },
  readArticles: {
    title: 'Read news articles',
    hint: 'Opens a few Pulse/news posts in the background toward Read Articles.',
  },
  watchVideos: {
    title: 'Watch videos',
    hint: 'Opens several Arena video pages in the background toward Watch Videos.',
  },
  gameVault: {
    title: 'Enter Game Vault',
    hint: 'Loads the Game Vault page in the background when Enter Game-Vault is still unearned.',
  },
};

export type AchievementKind = 'action' | 'inform';

export interface AchievementDefinition {
  id: string;
  title: string;
  aliases?: readonly string[];
  category: AchievementCategory;
  /**
   * Shared chain id — only the next unearned rank is advised.
   */
  group: string;
  rank: number;
  hint: string;
  href?: string;
  hrefLabel?: string;
  automation?: AchievementAutomationKey;
  /**
   * Daily ARP work already listed in the Artifact Optimizer action plan.
   */
  coveredByActionPlan?: boolean;
  kind: AchievementKind;
}

export const FAQ_PATH = '/faq-contact';
export const HIVE_PATH = '/information';
export const NEWS_PATH = '/news';
export const VIDEOS_PATH = '/videos';
export const RELAY_PATH = '/ucf';
export const GAME_VAULT_PATH = '/marketplace/game-vault';
// Member profile pages live at `/member/{username}` (not `/account/profile`).
export const PROFILE_PATH = '/member/{username}';

function slug(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

function define(
  title: string,
  category: AchievementCategory,
  options: {
    group?: string;
    rank?: number;
    hint: string;
    href?: string;
    hrefLabel?: string;
    automation?: AchievementAutomationKey;
    coveredByActionPlan?: boolean;
    kind?: AchievementKind;
    aliases?: readonly string[];
  },
): AchievementDefinition {
  const definition: AchievementDefinition = {
    id: slug(title),
    title,
    category,
    group: options.group ?? slug(title),
    rank: options.rank ?? 1,
    hint: options.hint,
    kind: options.kind ?? 'action',
  };
  if (options.aliases) {
    definition.aliases = options.aliases;
  }
  if (options.href) {
    definition.href = options.href;
  }
  if (options.hrefLabel) {
    definition.hrefLabel = options.hrefLabel;
  }
  if (options.automation) {
    definition.automation = options.automation;
  }
  if (options.coveredByActionPlan === true) {
    definition.coveredByActionPlan = true;
  }
  return definition;
}

export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  define('Verified Member', 'verified', {
    hint: 'Finish email / account verification if AWA still asks for it.',
    kind: 'inform',
  }),
  define('Add about me', 'profile', {
    hint: 'Add a short About Me on your profile.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    aliases: ['Add about me'],
    automation: 'profileCosmetics',
  }),

  define('Try it on', 'avatar', {
    group: 'border-use',
    rank: 1,
    hint: 'Change your profile border once.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),
  define('Use 5 different borders', 'avatar', {
    group: 'border-use',
    rank: 2,
    hint: 'Equip 5 different borders over time.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),
  define('Use 10 different borders', 'avatar', {
    group: 'border-use',
    rank: 3,
    hint: 'Keep rotating borders you have not used yet.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),
  define('Use 25 different borders', 'avatar', {
    group: 'border-use',
    rank: 4,
    hint: 'Calendar and marketplace borders count toward this.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),
  define('Change your border once a day for a week', 'avatar', {
    group: 'border-daily',
    rank: 1,
    hint: 'Change your border each UTC day for 7 days.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),
  define('Change your border once a month for a year', 'avatar', {
    group: 'border-monthly',
    rank: 1,
    hint: 'Change your border at least once each calendar month for 12 months.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),
  define('Change your avatar items every day for a week', 'avatar', {
    group: 'avatar-daily',
    rank: 1,
    hint: 'Change an avatar item each day for 7 days.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),
  define('Change your avatar once a month for 3 months', 'avatar', {
    group: 'avatar-monthly',
    rank: 1,
    hint: 'Change your avatar at least once a month for 3 months.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),
  define('Change your avatar once a month for 6 months', 'avatar', {
    group: 'avatar-monthly',
    rank: 2,
    hint: 'Keep a monthly avatar change going for 6 months.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),
  define('Change your avatar once a month for 1 year', 'avatar', {
    group: 'avatar-monthly',
    rank: 3,
    hint: 'Keep a monthly avatar change going for 12 months.',
    href: PROFILE_PATH,
    hrefLabel: 'Open profile',
    automation: 'profileCosmetics',
  }),

  define('Visit the FAQ page', 'visitPages', {
    hint: 'Open the FAQ / support page once.',
    href: FAQ_PATH,
    hrefLabel: 'Visit FAQ',
    automation: 'visitPages',
  }),
  define('Visit the Hive page', 'visitPages', {
    hint: 'Open the Hive / information page once.',
    href: HIVE_PATH,
    hrefLabel: 'Visit Hive',
    automation: 'visitPages',
  }),

  define('Watch 10 Videos', 'watchVideos', {
    group: 'watch-videos',
    rank: 1,
    hint: 'Watch 10 videos on Alienware Arena.',
    href: VIDEOS_PATH,
    hrefLabel: 'Open videos',
    automation: 'watchVideos',
  }),
  define('Watch 100 Videos', 'watchVideos', {
    group: 'watch-videos',
    rank: 2,
    hint: 'Keep watching Arena videos toward 100.',
    href: VIDEOS_PATH,
    hrefLabel: 'Open videos',
    automation: 'watchVideos',
  }),
  define('Watch 1000 Videos', 'watchVideos', {
    group: 'watch-videos',
    rank: 3,
    hint: 'Long-run video-watch achievement.',
    href: VIDEOS_PATH,
    hrefLabel: 'Open videos',
    kind: 'inform',
  }),

  define('Read 10 News Articles', 'readArticles', {
    group: 'read-articles',
    rank: 1,
    hint: 'Open 10 Pulse / news articles.',
    href: NEWS_PATH,
    hrefLabel: 'Open news',
    automation: 'readArticles',
  }),
  define('Read 100 News Articles', 'readArticles', {
    group: 'read-articles',
    rank: 2,
    hint: 'Keep reading Arena news toward 100.',
    href: NEWS_PATH,
    hrefLabel: 'Open news',
    automation: 'readArticles',
  }),
  define('Read 1000 News Articles', 'readArticles', {
    group: 'read-articles',
    rank: 3,
    hint: 'Long-run article-read achievement.',
    href: NEWS_PATH,
    hrefLabel: 'Open news',
    kind: 'inform',
  }),

  define('Enter Game-Vault', 'gameVault', {
    group: 'vault-enter',
    rank: 1,
    hint: 'Open the Game Vault page once.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    automation: 'gameVault',
  }),
  define('Enter Game-Vault 5 times', 'gameVault', {
    group: 'vault-enter',
    rank: 2,
    hint: 'Visit Game Vault on 5 different days / entries.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    automation: 'gameVault',
  }),
  define('Enter Game-Vault 12 times', 'gameVault', {
    group: 'vault-enter',
    rank: 3,
    hint: 'Keep entering Game Vault toward 12 visits.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    automation: 'gameVault',
  }),
  define('Enter Game-Vault 24 times', 'gameVault', {
    group: 'vault-enter',
    rank: 4,
    hint: 'Keep entering Game Vault toward 24 visits.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    automation: 'gameVault',
  }),
  define('Get 1 game from game vault', 'gameVault', {
    group: 'vault-claim',
    rank: 1,
    hint: 'Claim one Game Vault title when you have enough ARP.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    kind: 'inform',
  }),
  define('Get 5 games from game vault', 'gameVault', {
    group: 'vault-claim',
    rank: 2,
    hint: 'Claim 5 Game Vault titles over time.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    kind: 'inform',
  }),
  define('Get 10 games from game vault', 'gameVault', {
    group: 'vault-claim',
    rank: 3,
    hint: 'Claim 10 Game Vault titles over time.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    kind: 'inform',
  }),

  define('Post a relay', 'relay', {
    group: 'relay-post',
    rank: 1,
    hint: 'Post one Relay (community post).',
    href: RELAY_PATH,
    hrefLabel: 'Open Relay',
    aliases: ['Post a Relay'],
  }),
  define('Post 10 Relays', 'relay', {
    group: 'relay-post',
    rank: 2,
    hint: 'Post 10 Relays.',
    href: RELAY_PATH,
    hrefLabel: 'Open Relay',
  }),
  define('Post 50 relays', 'relay', {
    group: 'relay-post',
    rank: 3,
    hint: 'Post 50 Relays.',
    href: RELAY_PATH,
    hrefLabel: 'Open Relay',
  }),
  define('Comment on a relay', 'relay', {
    group: 'relay-comment',
    rank: 1,
    hint: "Leave a comment on someone else's Relay.",
    href: RELAY_PATH,
    hrefLabel: 'Open Relay',
  }),
  define('React to a relay', 'relay', {
    group: 'relay-react',
    rank: 1,
    hint: 'React to one Relay.',
    href: RELAY_PATH,
    hrefLabel: 'Open Relay',
  }),
  define('React to 10 relays', 'relay', {
    group: 'relay-react',
    rank: 2,
    hint: 'React to 10 Relays.',
    href: RELAY_PATH,
    hrefLabel: 'Open Relay',
  }),
  define('React to 50 relays', 'relay', {
    group: 'relay-react',
    rank: 3,
    hint: 'React to 50 Relays.',
    href: RELAY_PATH,
    hrefLabel: 'Open Relay',
  }),
  define('React to 100 relays', 'relay', {
    group: 'relay-react',
    rank: 4,
    hint: 'React to 100 Relays.',
    href: RELAY_PATH,
    hrefLabel: 'Open Relay',
  }),

  define('Vote on your first Arena Connect Poll', 'discord', {
    group: 'discord-poll',
    rank: 1,
    hint: 'Vote on the current Discord / Arena Connect poll (also in What to do).',
    coveredByActionPlan: true,
  }),
  define('Vote on 10 Arena Connect polls', 'discord', {
    group: 'discord-poll',
    rank: 2,
    hint: 'Keep voting on weekday Discord polls.',
    coveredByActionPlan: true,
  }),
  define('Vote on 50 Arena Connect polls', 'discord', {
    group: 'discord-poll',
    rank: 3,
    hint: 'Long-run Discord poll votes.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Vote on 100 Arena Connect polls', 'discord', {
    group: 'discord-poll',
    rank: 4,
    hint: 'Long-run Discord poll votes.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Vote on 500 Arena Connect polls', 'discord', {
    group: 'discord-poll',
    rank: 5,
    hint: 'Long-run Discord poll votes.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),

  define('Play all 3 Steam quests', 'steamQuests', {
    group: 'steam-all-three',
    rank: 1,
    hint: 'Finish all three weekly Steam quests (also in What to do).',
    coveredByActionPlan: true,
  }),
  define('Play all 3 Steam quests 5 times', 'steamQuests', {
    group: 'steam-all-three',
    rank: 2,
    hint: 'Clear all three Steam quests for 5 weeks.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Play all 3 Steam quests 10 times', 'steamQuests', {
    group: 'steam-all-three',
    rank: 3,
    hint: 'Clear all three Steam quests for 10 weeks.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Play all 3 Steam quests 20 times', 'steamQuests', {
    group: 'steam-all-three',
    rank: 4,
    hint: 'Clear all three Steam quests for 20 weeks.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Play all 3 Steam quests 50 times', 'steamQuests', {
    group: 'steam-all-three',
    rank: 5,
    hint: 'Clear all three Steam quests for 50 weeks.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 10 Steam Quests', 'steamQuests', {
    group: 'steam-quest-count',
    rank: 1,
    hint: 'Complete 10 Steam quests over time.',
    coveredByActionPlan: true,
  }),
  define('Steam: Play 25 Steam Quests', 'steamQuests', {
    group: 'steam-quest-count',
    rank: 2,
    hint: 'Complete 25 Steam quests over time.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 50 Steam Quests', 'steamQuests', {
    group: 'steam-quest-count',
    rank: 3,
    hint: 'Complete 50 Steam quests over time.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 100 Steam Quests', 'steamQuests', {
    group: 'steam-quest-count',
    rank: 4,
    hint: 'Complete 100 Steam quests over time.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 365 Steam Quests', 'steamQuests', {
    group: 'steam-quest-count',
    rank: 5,
    hint: 'Complete 365 Steam quests over time.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 10 hours', 'steamHours', {
    group: 'steam-hours',
    rank: 1,
    hint: 'Play tracked Steam hours through Arena quests.',
    coveredByActionPlan: true,
  }),
  define('Steam: Play 50 hours', 'steamHours', {
    group: 'steam-hours',
    rank: 2,
    hint: 'Keep playing Steam quests toward 50 hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 125 hours', 'steamHours', {
    group: 'steam-hours',
    rank: 3,
    hint: 'Keep playing Steam quests toward 125 hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 500 hours', 'steamHours', {
    group: 'steam-hours',
    rank: 4,
    hint: 'Long-run Steam hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 1000 hours', 'steamHours', {
    group: 'steam-hours',
    rank: 5,
    hint: 'Long-run Steam hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 2500 hours', 'steamHours', {
    group: 'steam-hours',
    rank: 6,
    hint: 'Long-run Steam hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Steam: Play 10000 hours', 'steamHours', {
    group: 'steam-hours',
    rank: 7,
    hint: 'Long-run Steam hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),

  define('Watch 10 hours of Twitch on Nexus channels', 'twitchNexus', {
    group: 'twitch-nexus',
    rank: 1,
    hint: 'Watch Twitch via Arena on Nexus channels (also in What to do).',
    coveredByActionPlan: true,
  }),
  define('Watch 100 hours of Twitch on Nexus channels', 'twitchNexus', {
    group: 'twitch-nexus',
    rank: 2,
    hint: 'Long-run Nexus Twitch hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Watch 1000 Hours of Twitch.tv on Nexus channels', 'twitchNexus', {
    group: 'twitch-nexus',
    rank: 3,
    hint: 'Long-run Nexus Twitch hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Watch 10 hours of Twitch.tv on Hive channels', 'twitchHive', {
    group: 'twitch-hive',
    rank: 1,
    hint: 'Watch Twitch via Arena on Hive channels.',
    coveredByActionPlan: true,
  }),
  define('Watch 100 Hours of Twitch.tv on Hive channels', 'twitchHive', {
    group: 'twitch-hive',
    rank: 2,
    hint: 'Long-run Hive Twitch hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Watch 1000 Hours of Twitch.tv on Hive channels', 'twitchHive', {
    group: 'twitch-hive',
    rank: 3,
    hint: 'Long-run Hive Twitch hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),

  define('Get your first border from Calendar rewards', 'calendarBorders', {
    group: 'calendar-borders',
    rank: 1,
    hint: 'Claim Daily Calendar until a border drops (also in What to do).',
    coveredByActionPlan: true,
  }),
  define('Get all the borders from a monthly calendar', 'calendarBorders', {
    group: 'calendar-borders',
    rank: 2,
    hint: 'Do not miss Daily Calendar days this month.',
    coveredByActionPlan: true,
  }),
  define('Get all borders from calendar for 3 months', 'calendarBorders', {
    group: 'calendar-borders',
    rank: 3,
    hint: 'Perfect calendar months stack.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Get all borders from calendar for 6 months', 'calendarBorders', {
    group: 'calendar-borders',
    rank: 4,
    hint: 'Perfect calendar months stack.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Get all borders from calendar for 1 year', 'calendarBorders', {
    group: 'calendar-borders',
    rank: 5,
    hint: 'Perfect calendar months stack.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Receive all 28-day rewards in a single month', 'streaks', {
    group: 'streaks-28',
    rank: 1,
    hint: 'Claim every Daily Calendar day in the 28-day track.',
    coveredByActionPlan: true,
  }),
  define('Receive all 28-day rewards for 3 months', 'streaks', {
    group: 'streaks-28',
    rank: 2,
    hint: 'Keep a perfect 28-day calendar streak for 3 months.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Receive all 28-day rewards for 6 months', 'streaks', {
    group: 'streaks-28',
    rank: 3,
    hint: 'Keep a perfect 28-day calendar streak for 6 months.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Receive all 28-day rewards for 1 year', 'streaks', {
    group: 'streaks-28',
    rank: 4,
    hint: 'Keep a perfect 28-day calendar streak for 12 months.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),

  define('Be a member for 1 year', 'years', {
    group: 'years',
    rank: 1,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),
  define('Be a member for 2 years', 'years', {
    group: 'years',
    rank: 2,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),
  define('Be a member for 3 years', 'years', {
    group: 'years',
    rank: 3,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),
  define('Be a member for 4 years', 'years', {
    group: 'years',
    rank: 4,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),
  define('Be a member for 5 years', 'years', {
    group: 'years',
    rank: 5,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),
  define('Be a member for 6 years', 'years', {
    group: 'years',
    rank: 6,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),
  define('Be a member for 7 years', 'years', {
    group: 'years',
    rank: 7,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),
  define('Be a member for 8 years', 'years', {
    group: 'years',
    rank: 8,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),
  define('Be a member for 9 years', 'years', {
    group: 'years',
    rank: 9,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),
  define('Be a member for 10 years', 'years', {
    group: 'years',
    rank: 10,
    hint: 'Passive — wait for the anniversary.',
    kind: 'inform',
  }),

  define('Reach Tier 2', 'tiers', {
    group: 'tiers',
    rank: 1,
    hint: 'Earn lifetime ARP to raise your Arena tier.',
    kind: 'inform',
  }),
  define('Reach Tier 3', 'tiers', {
    group: 'tiers',
    rank: 2,
    hint: 'Earn lifetime ARP to raise your Arena tier.',
    kind: 'inform',
  }),
  define('Reach Tier 4', 'tiers', {
    group: 'tiers',
    rank: 3,
    hint: 'Earn lifetime ARP to raise your Arena tier.',
    kind: 'inform',
  }),
  define('Reach Tier 5', 'tiers', {
    group: 'tiers',
    rank: 4,
    hint: 'Earn lifetime ARP to raise your Arena tier.',
    kind: 'inform',
  }),

  define('Participate in a Community Event', 'communityEvents', {
    group: 'community-events',
    rank: 1,
    hint: 'Play required hours in a live Community Event (also in What to do).',
    coveredByActionPlan: true,
  }),
  define('Participate in 2 Community Events', 'communityEvents', {
    group: 'community-events',
    rank: 2,
    hint: 'Join the next live Community Event.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Participate in 5 Community Events', 'communityEvents', {
    group: 'community-events',
    rank: 3,
    hint: 'Join live Community Events as they appear.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Participate in 10 Community Events', 'communityEvents', {
    group: 'community-events',
    rank: 4,
    hint: 'Join live Community Events as they appear.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Participate in 20 Community Events', 'communityEvents', {
    group: 'community-events',
    rank: 5,
    hint: 'Join live Community Events as they appear.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define(
    'Finish all required personal hours for a community event',
    'communityHours',
    {
      group: 'community-hours',
      rank: 1,
      hint: 'Finish the personal-hours track on a live event.',
      coveredByActionPlan: true,
    },
  ),
  define('Finish 20 personal hours for community events', 'communityHours', {
    group: 'community-hours',
    rank: 2,
    hint: 'Keep playing Community Event hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Finish 50 personal hours for community events', 'communityHours', {
    group: 'community-hours',
    rank: 3,
    hint: 'Keep playing Community Event hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Finish 100 personal hours for community events', 'communityHours', {
    group: 'community-hours',
    rank: 4,
    hint: 'Keep playing Community Event hours.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),

  define('Equip an artifact', 'artifacts', {
    group: 'artifact-equip',
    rank: 1,
    hint: 'Equip any artifact in the Showroom (also in What to do).',
    coveredByActionPlan: true,
  }),
  define('Equip 5 artifacts', 'artifacts', {
    group: 'artifact-equip',
    rank: 2,
    hint: 'Equip 5 different artifacts over time.',
    coveredByActionPlan: true,
  }),
  define('Equip 15 artifacts', 'artifacts', {
    group: 'artifact-equip',
    rank: 3,
    hint: 'Equip 15 different artifacts over time.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Upgrade an artifact', 'artifacts', {
    group: 'artifact-upgrade',
    rank: 1,
    hint: 'Spend fragments to upgrade any artifact.',
    coveredByActionPlan: true,
  }),
  define('Upgrade 3 artifacts', 'artifacts', {
    group: 'artifact-upgrade',
    rank: 2,
    hint: 'Upgrade 3 different artifacts.',
    coveredByActionPlan: true,
  }),
  define('Upgrade 7 Artifacts', 'artifacts', {
    group: 'artifact-upgrade',
    rank: 3,
    hint: 'Upgrade 7 different artifacts.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Fully Upgrade an artifact', 'artifacts', {
    group: 'artifact-max',
    rank: 1,
    hint: 'Take one artifact to max tier.',
    coveredByActionPlan: true,
  }),
  define('Fully Upgrade 3 artifacts', 'artifacts', {
    group: 'artifact-max',
    rank: 2,
    hint: 'Max 3 artifacts.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Fully Upgrade 5 artifacts', 'artifacts', {
    group: 'artifact-max',
    rank: 3,
    hint: 'Max 5 artifacts.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),

  define('Spend 100 ARP', 'spendArp', {
    group: 'spend-arp',
    rank: 1,
    hint: 'Spend ARP in Game Vault or the marketplace.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    kind: 'inform',
  }),
  define('Spend 1000 ARP', 'spendArp', {
    group: 'spend-arp',
    rank: 2,
    hint: 'Keep claiming vault / marketplace spends.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    kind: 'inform',
  }),
  define('Spend 5000 ARP', 'spendArp', {
    group: 'spend-arp',
    rank: 3,
    hint: 'Keep claiming vault / marketplace spends.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    kind: 'inform',
  }),
  define('Spend 10000 ARP', 'spendArp', {
    group: 'spend-arp',
    rank: 4,
    hint: 'Keep claiming vault / marketplace spends.',
    href: GAME_VAULT_PATH,
    hrefLabel: 'Open vault',
    kind: 'inform',
  }),

  define('Earn 5 fragments', 'fragments', {
    group: 'fragments',
    rank: 1,
    hint: 'Fragments drop from daily play and Battle Pass — already covered by daily ARP work.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Earn 15 fragments', 'fragments', {
    group: 'fragments',
    rank: 2,
    hint: 'Keep doing daily ARP sources.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Earn 30 fragments', 'fragments', {
    group: 'fragments',
    rank: 3,
    hint: 'Keep doing daily ARP sources.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
  define('Earn 50 fragments', 'fragments', {
    group: 'fragments',
    rank: 4,
    hint: 'Keep doing daily ARP sources.',
    coveredByActionPlan: true,
    kind: 'inform',
  }),
];

export function normalizeAchievementTitle(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

const ACHIEVEMENT_BY_ID = new Map(
  ACHIEVEMENTS.map((achievement) => [achievement.id, achievement]),
);

const ACHIEVEMENT_BY_TITLE = new Map<string, AchievementDefinition>();
for (const achievement of ACHIEVEMENTS) {
  ACHIEVEMENT_BY_TITLE.set(
    normalizeAchievementTitle(achievement.title),
    achievement,
  );
  const aliases = achievement.aliases ?? [];
  for (const alias of aliases) {
    ACHIEVEMENT_BY_TITLE.set(normalizeAchievementTitle(alias), achievement);
  }
}

export function getAchievementById(
  id: string,
): AchievementDefinition | undefined {
  return ACHIEVEMENT_BY_ID.get(id);
}

export function getAchievementByTitle(
  title: string,
): AchievementDefinition | undefined {
  return ACHIEVEMENT_BY_TITLE.get(normalizeAchievementTitle(title));
}

export function matchAchievementInText(
  text: string,
): AchievementDefinition | undefined {
  const haystack = normalizeAchievementTitle(text);
  let best: AchievementDefinition | undefined;
  let bestLength = 0;
  for (const achievement of ACHIEVEMENTS) {
    const names = [achievement.title, ...(achievement.aliases ?? [])];
    for (const name of names) {
      const needle = normalizeAchievementTitle(name);
      if (needle.length > bestLength && haystack.includes(needle)) {
        best = achievement;
        bestLength = needle.length;
      }
    }
  }
  return best;
}
