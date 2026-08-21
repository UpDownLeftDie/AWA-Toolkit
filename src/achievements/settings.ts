import { GM } from "$";
import {
  ACHIEVEMENT_AUTOMATION_KEYS,
  type AchievementAutomationKey,
} from "./data";

const SETTINGS_KEY = "achievementSettings";
const COOLDOWNS_KEY = "achievementCooldowns";

export type AchievementAutomationToggles = Record<
  AchievementAutomationKey,
  boolean
>;

export interface AchievementSettings {
  /**
  Master switch for background visits (FAQ/Hive, news, Game Vault).
  Off by default. Category toggles only run while this is on.
  */
  runAutomatically: boolean;
  automations: AchievementAutomationToggles;
}

/**
ISO date strings (YYYY-MM-DD) or ISO timestamps for last-run tracking.
*/
export interface AutomationCooldowns {
  /**
  Last UTC date (YYYY-MM-DD) border was rotated.
  */
  borderRotatedDate?: string;
  /**
  Last UTC date (YYYY-MM-DD) avatar item was rotated.
  */
  avatarRotatedDate?: string;
  /**
  Last UTC year-month (YYYY-MM) about-me was submitted.
  */
  aboutMeSubmittedMonth?: string;
  /**
  Last UTC date background visit automations ran.
  */
  visitPagesDate?: string;
  watchVideosDate?: string;
  readArticlesDate?: string;
  gameVaultDate?: string;
}

export function utcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function utcMonthString(now = new Date()): string {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

export async function loadAutomationCooldowns(): Promise<AutomationCooldowns> {
  try {
    const raw: string | undefined = await GM.getValue(COOLDOWNS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || !parsed) return {};
    const p = parsed as Record<string, unknown>;
    const result: AutomationCooldowns = {};
    if (typeof p.borderRotatedDate === "string") {
      result.borderRotatedDate = p.borderRotatedDate;
    }
    if (typeof p.avatarRotatedDate === "string") {
      result.avatarRotatedDate = p.avatarRotatedDate;
    }
    if (typeof p.aboutMeSubmittedMonth === "string") {
      result.aboutMeSubmittedMonth = p.aboutMeSubmittedMonth;
    }
    if (typeof p.visitPagesDate === "string") {
      result.visitPagesDate = p.visitPagesDate;
    }
    if (typeof p.watchVideosDate === "string") {
      result.watchVideosDate = p.watchVideosDate;
    }
    if (typeof p.readArticlesDate === "string") {
      result.readArticlesDate = p.readArticlesDate;
    }
    if (typeof p.gameVaultDate === "string") {
      result.gameVaultDate = p.gameVaultDate;
    }
    return result;
  } catch {
    return {};
  }
}

export async function saveAutomationCooldowns(
  patch: Partial<AutomationCooldowns>,
): Promise<void> {
  const existing = await loadAutomationCooldowns();
  await GM.setValue(COOLDOWNS_KEY, JSON.stringify({ ...existing, ...patch }));
}

const DEFAULT_AUTOMATIONS: AchievementAutomationToggles = {
  visitPages: false,
  profileCosmetics: false,
  watchVideos: false,
  readArticles: false,
  gameVault: false,
};

export const defaultAchievementSettings: AchievementSettings = {
  runAutomatically: false,
  automations: { ...DEFAULT_AUTOMATIONS },
};

function isPartialSettings(value: unknown): value is Partial<AchievementSettings> {
  return typeof value === "object" && !!value;
}

function mergeAutomations(
  base: AchievementAutomationToggles,
  incoming: Partial<AchievementAutomationToggles> | undefined,
): AchievementAutomationToggles {
  if (!incoming) {
    return base;
  }
  const next = { ...base };
  for (const key of ACHIEVEMENT_AUTOMATION_KEYS) {
    if (typeof incoming[key] === "boolean") {
      next[key] = incoming[key];
    }
  }
  return next;
}

export async function getAchievementSettings(): Promise<AchievementSettings> {
  const raw: string | Partial<AchievementSettings> | undefined =
    await GM.getValue(SETTINGS_KEY);
  const settings: AchievementSettings = {
    runAutomatically: false,
    automations: { ...DEFAULT_AUTOMATIONS },
  };
  if (!raw) {
    return settings;
  }
  try {
    const parsedUnknown: unknown =
      typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isPartialSettings(parsedUnknown)) {
      return settings;
    }
    if (typeof parsedUnknown.runAutomatically === "boolean") {
      settings.runAutomatically = parsedUnknown.runAutomatically;
    }
    settings.automations = mergeAutomations(
      settings.automations,
      parsedUnknown.automations,
    );
  } catch (error) {
    console.error("[Achievements] Error parsing settings:", error);
  }
  return settings;
}

export async function saveAchievementSettings(
  patch: {
    runAutomatically?: boolean;
    automations?: Partial<AchievementAutomationToggles>;
  },
): Promise<AchievementSettings> {
  const previous = await getAchievementSettings();
  const next: AchievementSettings = {
    runAutomatically:
      patch.runAutomatically ?? previous.runAutomatically,
    automations: patch.automations
      ? { ...previous.automations, ...patch.automations }
      : previous.automations,
  };
  await GM.setValue(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function areAchievementAutomationsEnabled(
  settings: AchievementSettings,
): boolean {
  return settings.runAutomatically;
}

export function isAchievementAutomationEnabled(
  settings: AchievementSettings,
  key: AchievementAutomationKey,
): boolean {
  return settings.runAutomatically && settings.automations[key];
}