import { saveArtifactSettings } from "../artifacts/settings";
import { renderActionPlanContents } from "../artifacts/ui/actionPlan";
import { showAoToast } from "../artifacts/ui/dialog";
import { escapeHtml } from "../artifacts/ui/loadoutPlan";
import {
  achievementProgressLabel,
  achievementUpdatedLabel,
  buildAchievementTodos,
} from "./advisor";
import {
  ACHIEVEMENT_AUTOMATION_COPY,
  ACHIEVEMENT_AUTOMATION_KEYS,
  type AchievementAutomationKey,
} from "./data";
import {
  isAchievementsPage,
  resolveAchievementsUrl,
  scrapeAchievementsFromDocument,
  saveAchievementSnapshot,
  type AchievementSnapshot,
} from "./scraper";
import {
  areAchievementAutomationsEnabled,
  saveAchievementSettings,
  type AchievementSettings,
  type AutomationCooldowns,
} from "./settings";

function renderSwitch(options: {
  id: string;
  title: string;
  hint: string;
  isChecked: boolean;
  isSmall?: boolean;
}): string {
  const sizeClass = options.isSmall === true ? " ao-switch-sm" : "";
  return `
      <label class="ao-switch${sizeClass}">
        <span class="ao-switch-copy">
          <span class="ao-switch-title">${escapeHtml(options.title)}</span>
          <span class="ao-switch-hint">${escapeHtml(options.hint)}</span>
        </span>
        <input type="checkbox" id="${escapeHtml(options.id)}" class="ao-switch-input" ${
          options.isChecked ? "checked" : ""
        }/>
        <span class="ao-switch-track" aria-hidden="true"><span class="ao-switch-knob"></span></span>
      </label>`;
}

function renderCategoryAutomationSwitches(
  settings: AchievementSettings,
): string {
  const switches = ACHIEVEMENT_AUTOMATION_KEYS.map((key) => {
    const copy = ACHIEVEMENT_AUTOMATION_COPY[key];
    return renderSwitch({
      id: `ao-ach-auto-${key}`,
      title: copy.title,
      hint: copy.hint,
      isChecked: settings.automations[key],
      isSmall: true,
    });
  }).join("");
  const isAutoOn = areAchievementAutomationsEnabled(settings);
  return `<div class="ao-ach-autos"${
    isAutoOn ? "" : ' data-off=""'
  }>${switches}</div>`;
}

/**
Achievements helper master switch (persists `achievementsEnabled`).
*/
export function renderAchievementHelperSwitch(isEnabled: boolean): string {
  return renderSwitch({
    id: "ao-achievements-enabled",
    title: "Achievements helper",
    hint: "Show what to do next for unearned achievements. Turn on Run automatically to visit pages in the background.",
    isChecked: isEnabled,
  });
}

/**
Master "Run automatically" switch. Pass `masterOnly: true` to hide
per-category toggles (Control Center).
*/
export function renderAchievementAutoControls(
  settings: AchievementSettings,
  options: { masterOnly?: boolean } = {},
): string {
  const isAutoOn = areAchievementAutomationsEnabled(settings);
  const master = renderSwitch({
    id: "ao-ach-run-automatically",
    title: "Run automatically",
    hint: "On each Refresh, do the safe background actions for achievements: visit FAQ/Hive, save your About Me, rotate your border, open video pages, open news posts, and enter Game Vault when those are still unearned. Does not post Relays or spend ARP.",
    isChecked: isAutoOn,
  });
  if (options.masterOnly === true) {
    return master;
  }
  return `
    ${master}
    <div class="ao-ach-sub${isAutoOn ? "" : " ao-ach-sub--off"}">
      ${renderCategoryAutomationSwitches(settings)}
    </div>`;
}

export function renderAchievementsPanel(options: {
  snapshot: AchievementSnapshot | undefined;
  settings: AchievementSettings;
  isEnabled: boolean;
  compact?: boolean;
  cooldowns?: AutomationCooldowns;
}): string {
  if (!options.isEnabled) {
    return "";
  }
  const todos = buildAchievementTodos(
    options.snapshot,
    options.settings,
    options.cooldowns ?? {},
  );
  const progress = achievementProgressLabel(options.snapshot);
  const updated = achievementUpdatedLabel(options.snapshot);
  const heading = `Achievements · ${progress}`;
  const contents = renderActionPlanContents(todos, { heading });
  return `
    <div id="ao-achievements">
      <div class="ao-muted">${escapeHtml(updated)}</div>
      ${contents}
    </div>
  `;
}

/**
Control Center task list only (helper + automation switches live in Full Panel).
*/
export function renderAchievementsControlBlock(options: {
  isHelperEnabled: boolean;
  snapshot: AchievementSnapshot | undefined;
  settings: AchievementSettings;
  cooldowns?: AutomationCooldowns;
}): string {
  if (!options.isHelperEnabled) {
    return "";
  }
  return renderAchievementsPanel({
    snapshot: options.snapshot,
    settings: options.settings,
    isEnabled: true,
    ...(options.cooldowns !== undefined && { cooldowns: options.cooldowns }),
  });
}

async function fetchAndMaybeScrapeAchievements(href: string): Promise<void> {
  const response = await fetch(href, { headers: { Accept: "text/html" } });
  if (!response.ok) {
    throw new Error(`GET ${href} failed: ${String(response.status)}`);
  }
  const path = new URL(href, location.origin).pathname;
  if (!isAchievementsPage(path)) {
    return;
  }
  const document_ = new DOMParser().parseFromString(
    await response.text(),
    "text/html",
  );
  const snapshot = scrapeAchievementsFromDocument(document_, {
    pathHint: path,
  });
  if (Object.keys(snapshot.items).length > 0) {
    await saveAchievementSnapshot(snapshot);
  }
}

export function bindAchievementOpenButtons(
  root: ParentNode,
  onVisited?: () => Promise<void>,
): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    ".ao-ach-open-btn",
  )) {
    button.addEventListener("click", () => {
      const href = button.dataset.href;
      if (!href) {
        return;
      }
      if (button.dataset.visit === "1") {
        void (async () => {
          try {
            await fetchAndMaybeScrapeAchievements(href);
            const isProgressLoad =
              href.includes("/achievements") ||
              href === resolveAchievementsUrl();
            showAoToast(
              isProgressLoad
                ? "Achievement progress updated."
                : "Visited page for achievement progress.",
            );
            await onVisited?.();
          } catch (error) {
            console.warn("[Achievements] Visit failed", href, error);
            location.assign(href);
          }
        })();
        return;
      }
      location.assign(href);
    });
  }
}

function syncAchievementAutoEnabled(root: ParentNode, isOn: boolean): void {
  const sub = root.querySelector<HTMLElement>(".ao-ach-sub");
  if (!sub) {
    return;
  }
  sub.classList.toggle("ao-ach-sub--off", !isOn);
}

/**
Persist Achievements helper toggle. Call from any panel that renders
`#ao-achievements-enabled`.
*/
export function bindAchievementHelperSwitch(
  root: ParentNode,
  onChanged: () => Promise<void>,
): void {
  root
    .querySelector<HTMLInputElement>("#ao-achievements-enabled")
    ?.addEventListener("change", (event) => {
      const input = event.currentTarget;
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      void (async () => {
        await saveArtifactSettings({ achievementsEnabled: input.checked });
        await onChanged();
      })();
    });
}

export function bindAchievementAutomationSwitches(
  root: ParentNode,
  onChanged: () => Promise<void>,
): void {
  root
    .querySelector<HTMLInputElement>("#ao-ach-run-automatically")
    ?.addEventListener("change", (event) => {
      const input = event.currentTarget;
      if (!(input instanceof HTMLInputElement)) {
        return;
      }
      void (async () => {
        if (!input.checked) {
          await saveAchievementSettings({ runAutomatically: false });
          syncAchievementAutoEnabled(root, false);
          await onChanged();
          return;
        }
        await saveArtifactSettings({ achievementsEnabled: true });
        await saveAchievementSettings({
          runAutomatically: true,
          automations: {
            visitPages: true,
            profileCosmetics: true,
            watchVideos: true,
            readArticles: true,
            gameVault: true,
          },
        });
        syncAchievementAutoEnabled(root, true);
        for (const key of ACHIEVEMENT_AUTOMATION_KEYS) {
          const category = root.querySelector<HTMLInputElement>(
            `#ao-ach-auto-${CSS.escape(key)}`,
          );
          if (category) {
            category.checked = true;
          }
        }
        await onChanged();
      })();
    });
  for (const key of ACHIEVEMENT_AUTOMATION_KEYS) {
    root
      .querySelector<HTMLInputElement>(`#ao-ach-auto-${CSS.escape(key)}`)
      ?.addEventListener("change", (event) => {
        const input = event.currentTarget;
        if (!(input instanceof HTMLInputElement)) {
          return;
        }
        void saveAutomation(key, input.checked).then(onChanged);
      });
  }
}

async function saveAutomation(
  key: AchievementAutomationKey,
  isEnabled: boolean,
): Promise<void> {
  await saveAchievementSettings({
    automations: { [key]: isEnabled },
  });
}
