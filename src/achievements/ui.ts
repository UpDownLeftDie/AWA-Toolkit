import { saveArtifactSettings } from "../artifacts/settings";
import { renderActionPlanContents } from "../artifacts/ui/actionPlan";
import { showAoToast } from "../artifacts/ui/dialog";
import { escapeHtml } from "../artifacts/ui/loadoutPlan";
import { achievementProgressLabel, buildAchievementTodos } from "./advisor";
import {
  ACHIEVEMENT_AUTOMATION_COPY,
  ACHIEVEMENT_AUTOMATION_KEYS,
  type AchievementAutomationKey,
} from "./data";
import type { AchievementSnapshot } from "./scraper";
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
 * Master "Run automatically" switch plus per-action toggles.
 */
export function renderAchievementAutoControls(
  settings: AchievementSettings,
): string {
  const isAutoOn = areAchievementAutomationsEnabled(settings);
  return `
    ${renderSwitch({
      id: "ao-ach-run-automatically",
      title: "Run automatically",
      hint: "On each Refresh, do the safe background actions for achievements: visit FAQ/Hive, save your About Me, rotate your border, open video pages, open news posts, and enter Game Vault when those are still unearned. Does not post Relays or spend ARP.",
      isChecked: isAutoOn,
    })}
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
  const heading = `Achievements · ${progress}`;
  const contents = renderActionPlanContents(todos, { heading });
  return `
    <div id="ao-achievements">
      ${contents}
    </div>
  `;
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
            await fetch(href, { headers: { Accept: "text/html" } });
            showAoToast("Visited page for achievement progress.");
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
