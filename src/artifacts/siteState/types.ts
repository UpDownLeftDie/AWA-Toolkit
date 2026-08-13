import type { ArpLogState } from './arpLog';
import type { BattlePassState } from './battlePass';
import type { WatchTwitchProgress } from './caps';
import type { CommunityEventState } from './communityEvent';
import type { DailyQuestsState } from './dailyQuests';
import type { GameVaultItem } from './gameVault';
import type { SteamQuestsState } from './steamQuests';

export type ActivityKey =
  | 'timeOnSite'
  | 'steamQuests'
  | 'watchTwitch'
  | 'dailyCalendar'
  | 'discordPoll'
  | 'dailyQuests'
  | 'steamCommunityEvent';

export type CapStatus = 'available' | 'capped' | 'unknown';

export interface ActivityCapState {
  timeOnSite: CapStatus;
  steamQuests: CapStatus;
  watchTwitch: CapStatus;
  dailyCalendar: CapStatus;
  discordPoll: CapStatus;
  dailyQuests: CapStatus;
  steamCommunityEvent: CapStatus;
}

export interface SiteState {
  updatedAt: string;
  caps: ActivityCapState;
  gameVault: GameVaultItem[];
  /**
  Next Game Vault open time from `#game-vault-timer` while claims are closed.
  */
  gameVaultOpensAt?: string;
  /**
  Arena tier (`window.arp_tier` / tier-tag). Used for vault eligibility.
  */
  userArpTier?: number;
  battlePass?: BattlePassState;
  arpLog?: ArpLogState;
  communityEvent?: CommunityEventState;
  watchTwitch?: WatchTwitchProgress;
  steamQuests?: SteamQuestsState;
  dailyQuests?: DailyQuestsState;
}
