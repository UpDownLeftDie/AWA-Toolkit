import { describe, expect, it } from "vitest";

import { buildAchievementTodos } from "../../src/achievements/advisor";
import { defaultAchievementSettings } from "../../src/achievements/settings";

describe("achievements advisor", () => {
  it("substitutes {username} in profile hrefs", () => {
    const snapshot = {
      scrapedAt: new Date().toISOString(),
      username: "CamKitties",
      earnedCount: 0,
      totalCount: 0,
      items: {},
    };

    const todos = buildAchievementTodos(snapshot, defaultAchievementSettings);
    const addAboutMe = todos.find((t) =>
      t.text.includes("Add about me"),
    );
    expect(addAboutMe).toBeDefined();
    expect(addAboutMe?.openHref).toBe("/member/CamKitties");
  });

  it("hides automated border todos after today's rotation", () => {
    const snapshot = {
      scrapedAt: new Date().toISOString(),
      username: "CamKitties",
      earnedCount: 0,
      totalCount: 10,
      items: {},
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
});

