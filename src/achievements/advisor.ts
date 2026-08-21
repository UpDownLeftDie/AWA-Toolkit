import type { ActionTodo } from "../artifacts/ui/actionPlan";
import { ACHIEVEMENTS, type AchievementDefinition } from "./data";
import type { AchievementSnapshot } from "./scraper";
import {
  isAchievementAutomationEnabled,
  utcDateString,
  type AchievementSettings,
  type AutomationCooldowns,
} from "./settings";

const MAX_ACTION_TODOS = 8;
const MAX_INFORM_TODOS = 3;

const BORDER_GROUPS = new Set([
  "border-use",
  "border-daily",
  "border-monthly",
]);
const AVATAR_GROUPS = new Set(["avatar-daily", "avatar-monthly"]);

function isAchievementEarned(
  snapshot: AchievementSnapshot | undefined,
  id: string,
): boolean {
  return snapshot?.items[id]?.isEarned === true;
}

function nextUnearnedInGroup(
  snapshot: AchievementSnapshot | undefined,
  group: string,
): AchievementDefinition | undefined {
  const chain = ACHIEVEMENTS.filter(
    (achievement) => achievement.group === group,
  ).toSorted((left, right) => left.rank - right.rank);
  return chain.find(
    (achievement) => !isAchievementEarned(snapshot, achievement.id),
  );
}

function collectNextUnearned(
  snapshot: AchievementSnapshot | undefined,
): AchievementDefinition[] {
  const seenGroups = new Set<string>();
  const nexts: AchievementDefinition[] = [];
  for (const achievement of ACHIEVEMENTS) {
    if (seenGroups.has(achievement.group)) {
      continue;
    }
    seenGroups.add(achievement.group);
    const next = nextUnearnedInGroup(snapshot, achievement.group);
    if (next && next.coveredByActionPlan !== true) {
      nexts.push(next);
    }
  }
  return nexts;
}

/**
 * When automation already ran for this UTC day, hide the item until the next day.
 */
function isSatisfiedForCurrentInterval(
  achievement: AchievementDefinition,
  settings: AchievementSettings,
  cooldowns: AutomationCooldowns,
  today: string,
): boolean {
  const key = achievement.automation;
  if (key === undefined || !isAchievementAutomationEnabled(settings, key)) {
    return false;
  }
  if (key === "profileCosmetics") {
    if (BORDER_GROUPS.has(achievement.group)) {
      return cooldowns.borderRotatedDate === today;
    }
    if (AVATAR_GROUPS.has(achievement.group)) {
      return cooldowns.avatarRotatedDate === today;
    }
    if (achievement.id === "add-about-me") {
      return cooldowns.aboutMeSubmittedMonth !== undefined;
    }
    return false;
  }
  if (key === "visitPages") {
    return cooldowns.visitPagesDate === today;
  }
  if (key === "watchVideos") {
    return cooldowns.watchVideosDate === today;
  }
  if (key === "readArticles") {
    return cooldowns.readArticlesDate === today;
  }
  if (key === "gameVault") {
    return cooldowns.gameVaultDate === today;
  }
  return false;
}

function buildTodo(
  achievement: AchievementDefinition,
  settings: AchievementSettings,
  username?: string,
): ActionTodo {
  const canAutomate =
    achievement.automation !== undefined &&
    isAchievementAutomationEnabled(settings, achievement.automation);
  const canVisitInBackground =
    canAutomate && achievement.automation !== "profileCosmetics";
  const todo: ActionTodo = {
    text: achievement.title,
    reasons: [{ text: achievement.hint }],
    tone: achievement.kind === "inform" ? "muted" : "default",
    urgency: {
      kind: achievement.kind === "inform" ? "info" : "action",
      readyAtMs: 0,
      durationMs: 0,
    },
  };
  if (achievement.href) {
    const href = achievement.href;
    const resolvedHref =
      username && href.includes("{username}")
        ? href.split("{username}").join(encodeURIComponent(username))
        : href;
    todo.openHref = resolvedHref;
    todo.openHrefLabel = canAutomate
      ? `${achievement.hrefLabel ?? "Open"} now`
      : (achievement.hrefLabel ?? "Open");
    if (canVisitInBackground) {
      todo.visitInBackground = true;
    }
  }
  return todo;
}

function emptyTodos(snapshot: AchievementSnapshot | undefined): ActionTodo[] {
  if (!snapshot || Object.keys(snapshot.items).length === 0) {
    return [
      {
        tone: "muted",
        text: "Achievements page not scraped yet — Refresh to load progress",
        urgency: { kind: "info", readyAtMs: 0, durationMs: 0 },
      },
    ];
  }
  return [
    {
      tone: "muted",
      text: "No extra achievement steps — daily ARP work already covers the rest",
      urgency: { kind: "info", readyAtMs: 0, durationMs: 0 },
    },
  ];
}

/**
 * Next unearned achievements that are not already daily ARP work.
 * Chains collapse to the lowest unearned rank.
 * Automations already done for today are hidden until the next UTC day.
 */
export function buildAchievementTodos(
  snapshot: AchievementSnapshot | undefined,
  settings: AchievementSettings,
  cooldowns: AutomationCooldowns = {},
): ActionTodo[] {
  const actions: ActionTodo[] = [];
  const infos: ActionTodo[] = [];
  const today = utcDateString();
  const collected = collectNextUnearned(snapshot).filter(
    (next) => !isSatisfiedForCurrentInterval(next, settings, cooldowns, today),
  );
  for (const next of collected) {
    const todo = buildTodo(next, settings, snapshot?.username);
    if (next.kind === "inform") {
      if (infos.length < MAX_INFORM_TODOS) {
        infos.push(todo);
      }
      continue;
    }
    if (actions.length < MAX_ACTION_TODOS) {
      actions.push(todo);
    }
  }
  if (actions.length === 0 && infos.length === 0) {
    return emptyTodos(snapshot);
  }
  return [...actions, ...infos];
}

export function achievementProgressLabel(
  snapshot: AchievementSnapshot | undefined,
): string {
  if (!snapshot || snapshot.totalCount <= 0) {
    return "progress unknown";
  }
  return `${snapshot.earnedCount}/${snapshot.totalCount} earned`;
}
