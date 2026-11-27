import type { ActionTodo } from "../artifacts/plan/types";
import { readPageUsername } from "../pageGlobals";
import { ACHIEVEMENTS, type AchievementDefinition } from "./data";
import {
  resolveAchievementsUrl,
  type AchievementSnapshot,
} from "./scraper";
import {
  isAchievementAutomationEnabled,
  utcDateString,
  utcMonthString,
  type AchievementSettings,
  type AutomationCooldowns,
} from "./settings";

function linkUsername(snapshot: AchievementSnapshot | undefined): string | undefined {
  try {
    return readPageUsername() ?? snapshot?.username;
  } catch {
    return snapshot?.username;
  }
}

const MAX_ACTION_TODOS = 8;
const MAX_INFORM_TODOS = 3;

const BORDER_GROUPS = new Set([
  "border-first",
  "border-use",
  "border-daily",
  "border-monthly",
]);
const AVATAR_GROUPS = new Set(["avatar-daily", "avatar-monthly"]);
const ABOUT_ME_ID = "add-about-me";

function isAchievementEarned(
  snapshot: AchievementSnapshot | undefined,
  id: string,
): boolean {
  return snapshot?.items[id]?.isEarned === true;
}

/**
Only advise when the scrape positively marked an item unearned. Missing keys
(unscraped / new catalog entries) are unknown — not assumed incomplete.
*/
function isAchievementKnownUnearned(
  snapshot: AchievementSnapshot | undefined,
  id: string,
): boolean {
  return snapshot?.items[id]?.isEarned === false;
}

function nextUnearnedInGroup(
  snapshot: AchievementSnapshot | undefined,
  group: string,
): AchievementDefinition | undefined {
  const chain = ACHIEVEMENTS.filter(
    (achievement) => achievement.group === group,
  ).toSorted((left, right) => left.rank - right.rank);
  // If nothing in the chain was scraped, skip the group (avoid listing
  // every achievement when the snapshot is empty or partial).
  const isGroupScraped = chain.some(
    (achievement) => snapshot?.items[achievement.id] !== undefined,
  );
  if (!isGroupScraped) {
    return undefined;
  }
  // Higher earned rank implies lower ranks are done (stacked cards).
  const maxEarnedRank = Math.max(
    0,
    ...chain
      .filter((achievement) => isAchievementEarned(snapshot, achievement.id))
      .map((achievement) => achievement.rank),
  );
  return chain.find(
    (achievement) =>
      achievement.rank > maxEarnedRank &&
      isAchievementKnownUnearned(snapshot, achievement.id),
  );
}

function collectNextUnearned(
  snapshot: AchievementSnapshot | undefined,
): AchievementDefinition[] {
  if (!snapshot || Object.keys(snapshot.items).length === 0) {
    return [];
  }
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
When automation already ran for this UTC day, hide the item until the next day.
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
    // About-me: never permanently hide here — buildAchievementTodos shows a
    // muted "waiting for credit" row for the submit month instead.
    return false;
  }
  if (key === "visitPages") {
    return cooldowns.visitPagesDate === today;
  }
  if (key === "watchVideos") {
    return cooldowns.watchVideosDate === today;
  }
  return (key === "readArticles" ? cooldowns.readArticlesDate : cooldowns.gameVaultDate) === today;
}

function resolveAchievementHref(
  href: string,
  username?: string,
): string {
  return username && href.includes("{username}")
    ? href.split("{username}").join(encodeURIComponent(username))
    : href;
}

function attachTodoHref(
  todo: ActionTodo,
  achievement: AchievementDefinition,
  options: {
    canAutomate: boolean;
    canVisitInBackground: boolean;
    username?: string;
  },
): void {
  if (!achievement.href) {
    return;
  }
  const resolvedHref = resolveAchievementHref(
    achievement.href,
    options.username,
  );
  // Profile cosmetics run via API on Refresh — don't look like a manual chore.
  if (options.canAutomate && achievement.automation === "profileCosmetics") {
    todo.tone = "muted";
    todo.reasons = [
      {
        text: `${achievement.hint} Runs automatically on Refresh.`,
      },
    ];
    todo.openHref = resolvedHref;
    todo.openHrefLabel = "Open if stuck";
    return;
  }
  todo.openHref = resolvedHref;
  todo.openHrefLabel = options.canAutomate
    ? `${achievement.hrefLabel ?? "Open"} now`
    : (achievement.hrefLabel ?? "Open");
  if (options.canVisitInBackground) {
    todo.visitInBackground = true;
  }
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
  attachTodoHref(todo, achievement, {
    canAutomate,
    canVisitInBackground,
    ...(username !== undefined && { username }),
  });
  return todo;
}

function progressNeededTodo(
  snapshot: AchievementSnapshot | undefined,
): ActionTodo {
  const href = resolveAchievementsUrl(linkUsername(snapshot));
  const todo: ActionTodo = {
    text: "Load achievement progress",
    reasons: [
      {
        text: "We fetch your achievements page in the background (like Battle Pass). If this stays, use the button to retry or open the page.",
      },
    ],
    urgency: { kind: "action", readyAtMs: 0, durationMs: 0 },
  };
  if (href) {
    todo.openHref = href;
    todo.openHrefLabel = "Load progress";
    // Background fetch + scrape (see bindAchievementOpenButtons).
    todo.visitInBackground = true;
  }
  return todo;
}

function emptyTodos(snapshot: AchievementSnapshot | undefined): ActionTodo[] {
  if (!snapshot || Object.keys(snapshot.items).length === 0) {
    return [progressNeededTodo(snapshot)];
  }
  return [
    {
      tone: "muted",
      text: "No extra achievement steps — daily ARP work already covers the rest",
      urgency: { kind: "info", readyAtMs: 0, durationMs: 0 },
    },
  ];
}

function aboutMeWaitingTodo(
  achievement: AchievementDefinition,
): ActionTodo {
  return {
    text: achievement.title,
    reasons: [{ text: "Submitted this month — waiting for credit" }],
    tone: "muted",
    urgency: { kind: "info", readyAtMs: 0, durationMs: 0 },
  };
}

function isAboutMeWaitingCredit(
  achievement: AchievementDefinition,
  snapshot: AchievementSnapshot | undefined,
  cooldowns: AutomationCooldowns,
  thisMonth: string,
): boolean {
  return (
    achievement.id === ABOUT_ME_ID &&
    cooldowns.aboutMeSubmittedMonth === thisMonth &&
    !isAchievementEarned(snapshot, ABOUT_ME_ID)
  );
}

function pushCapped(
  list: ActionTodo[],
  todo: ActionTodo,
  max: number,
): void {
  if (list.length < max) {
    list.push(todo);
  }
}

/**
Next unearned achievements that are not already daily ARP work.
Chains collapse to the lowest unearned rank.
Automations already done for today are hidden until the next UTC day.
*/
export function buildAchievementTodos(
  snapshot: AchievementSnapshot | undefined,
  settings: AchievementSettings,
  cooldowns: AutomationCooldowns = {},
): ActionTodo[] {
  const actions: ActionTodo[] = [];
  const infos: ActionTodo[] = [];
  const today = utcDateString();
  const thisMonth = utcMonthString();
  const collected = collectNextUnearned(snapshot).filter(
    (next) => !isSatisfiedForCurrentInterval(next, settings, cooldowns, today),
  );
  for (const next of collected) {
    if (isAboutMeWaitingCredit(next, snapshot, cooldowns, thisMonth)) {
      pushCapped(infos, aboutMeWaitingTodo(next), MAX_INFORM_TODOS);
      continue;
    }
    const todo = buildTodo(next, settings, linkUsername(snapshot));
    if (next.kind === "inform") {
      pushCapped(infos, todo, MAX_INFORM_TODOS);
      continue;
    }
    pushCapped(actions, todo, MAX_ACTION_TODOS);
  }
  return actions.length === 0 && infos.length === 0
    ? emptyTodos(snapshot)
    : [...actions, ...infos];
}

export function achievementProgressLabel(
  snapshot: AchievementSnapshot | undefined,
): string {
  return !snapshot || snapshot.totalCount <= 0 ? "progress unknown" : `${snapshot.earnedCount}/${snapshot.totalCount} earned`;
}

/**
Locale timestamp for when achievement progress was last scraped (`scrapedAt`).
*/
export function achievementUpdatedLabel(
  snapshot: AchievementSnapshot | undefined,
): string {
  const scrapedAt = snapshot?.scrapedAt;
  if (!scrapedAt) {
    return "Updated: never";
  }
  const at = Date.parse(scrapedAt);
  if (Number.isNaN(at) || at <= 0) {
    return "Updated: never";
  }
  return `Updated: ${new Date(at).toLocaleString()}`;
}
