import { describe, expect, it } from "vitest";

import { buildAchievementTodos } from "../../src/achievements/advisor";
import { ACHIEVEMENTS } from "../../src/achievements/data";
import {
  defaultAchievementSettings,
  utcMonthString,
} from "../../src/achievements/settings";

describe("achievements advisor", () => {
  it("substitutes {username} in profile hrefs", () => {
    const snapshot = {
      scrapedAt: new Date().toISOString(),
      username: "CamKitties",
      earnedCount: 0,
      totalCount: 10,
      items: {
        "add-about-me": {
          id: "add-about-me",
          title: "Add about me",
          isEarned: false,
        },
      },
    };

    const todos = buildAchievementTodos(snapshot, defaultAchievementSettings);
    const addAboutMe = todos.find((t) =>
      t.text.includes("Add about me"),
    );
    expect(addAboutMe).toBeDefined();
    expect(addAboutMe?.openHref).toBe("/account/personalization");
  });

  it("offers a load-progress CTA when the scrape has no items yet", () => {
    const snapshot = {
      scrapedAt: new Date().toISOString(),
      username: "CamKitties",
      earnedCount: 0,
      totalCount: 0,
      items: {},
    };
    const todos = buildAchievementTodos(snapshot, defaultAchievementSettings);
    expect(todos).toHaveLength(1);
    expect(todos[0]?.text).toMatch(/load achievement progress/i);
    expect(todos[0]?.openHref).toBe("/member/CamKitties/achievements");
    expect(todos[0]?.visitInBackground).toBe(true);
  });

  it("does not list connection todos that were never scraped as unearned", () => {
    const snapshot = {
      scrapedAt: new Date().toISOString(),
      username: "CamKitties",
      earnedCount: 5,
      totalCount: 118,
      items: {
        "visit-the-faq-page": {
          id: "visit-the-faq-page",
          title: "Visit the FAQ page",
          isEarned: true,
        },
      },
    };
    const todos = buildAchievementTodos(snapshot, defaultAchievementSettings);
    expect(todos.some((todo) => /discord|steam|twitch/i.test(todo.text))).toBe(
      false,
    );
    expect(todos.some((todo) => todo.text.includes("Visit the FAQ"))).toBe(
      false,
    );
  });

  it("shows muted waiting row after about-me submit this month", () => {
    const snapshot = {
      scrapedAt: new Date().toISOString(),
      username: "CamKitties",
      earnedCount: 0,
      totalCount: 10,
      items: {
        "add-about-me": {
          id: "add-about-me",
          title: "Add about me",
          isEarned: false,
        },
      },
    };
    const todos = buildAchievementTodos(snapshot, defaultAchievementSettings, {
      aboutMeSubmittedMonth: utcMonthString(),
    });
    const about = todos.find((todo) => todo.text === "Add about me");
    expect(about).toBeDefined();
    expect(about?.tone).toBe("muted");
    expect(about?.reasons?.[0]?.text).toMatch(/waiting for credit/i);
    expect(about?.openHref).toBeUndefined();
  });

  it("hides automated border todos after today's rotation", () => {
    const unearnedBorders = {
      "add-your-first-border": {
        id: "add-your-first-border",
        title: "Add your first border",
        isEarned: false,
      },
      "try-it-on": {
        id: "try-it-on",
        title: "Try it on",
        isEarned: false,
      },
      "change-your-border-once-a-month-for-a-year": {
        id: "change-your-border-once-a-month-for-a-year",
        title: "Change your border once a month for a year",
        isEarned: false,
      },
    };
    const snapshot = {
      scrapedAt: new Date().toISOString(),
      username: "CamKitties",
      earnedCount: 0,
      totalCount: 10,
      items: unearnedBorders,
    };
    const settings = {
      ...defaultAchievementSettings,
      runAutomatically: true,
      automations: {
        ...defaultAchievementSettings.automations,
        profileCosmetics: true,
      },
    };
    const withCooldown = buildAchievementTodos(snapshot, settings, {
      borderRotatedDate: new Date().toISOString().slice(0, 10),
    });
    expect(withCooldown.some((t) => t.text.includes("Try it on"))).toBe(
      false,
    );
    expect(withCooldown.some((t) => t.text.includes("Add your first border"))).toBe(
      false,
    );
    expect(
      withCooldown.some((t) =>
        t.text.includes("Change your border once a month"),
      ),
    ).toBe(false);

    const withoutCooldown = buildAchievementTodos(snapshot, settings, {});
    expect(withoutCooldown.some((t) => t.text.includes("Try it on"))).toBe(
      true,
    );
  });

  it("covers the live onboarding titles that were missing from the catalog", () => {
    const titles = new Set(ACHIEVEMENTS.map((achievement) => achievement.title));
    for (const title of [
      "Add your first border",
      "Add a background (Header Image)",
      "Spend 1 hour on AWA",
      "Connect Discord",
      "Connect your Twitch account",
      "Connect your Steam account",
      "Enter A Comm Event",
      "Make your first purchase in the Marketplace",
    ]) {
      expect(titles.has(title)).toBe(true);
    }
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(118);
  });
});

