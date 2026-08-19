import {
  ARTIFACT_SETS,
  ArtifactEffectType,
  BASE_ACTIVITY,
  TIER_LABELS,
  listArtifactNameEntries,
  type ArtifactDefinition,
  type ArtifactNameEntry,
  type ArtifactSetDefinition,
  type ArtifactTier,
} from "../data";
import { escapeHtml } from "./loadoutPlan";
import { ARTIFACT_TIP_ID, ensureOptimizerStyles } from "./styles";

interface ArtifactTipCopy {
  title: string;
  meta: string;
  effect: string;
  detail?: string;
  setBonus?: string;
}

function formatSigned(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : `+${value}`;
}

function formatPct(value: number): string {
  const pct = value * 100;
  const abs = Math.abs(pct);
  const rounded = Number.isSafeInteger(abs) ? String(abs) : abs.toFixed(1);
  return `${pct < 0 ? "−" : "+"}${rounded}%`;
}

function describeNumericEffect(
  type: ArtifactEffectType,
  value: number,
): { effect: string; detail?: string } {
  switch (type) {
    case ArtifactEffectType.SteamQuests: {
      return { effect: `${formatSigned(value)} Steam Quests ARP` };
    }
    case ArtifactEffectType.WatchTwitch: {
      const cap = BASE_ACTIVITY.watchTwitchBasePerDay + value;
      return {
        effect: `${formatSigned(value)} Watch Twitch ARP`,
        detail: `Raises the daily Twitch cap to ${cap} (1 ARP/min).`,
      };
    }
    case ArtifactEffectType.DailyCalendar: {
      return { effect: `${formatSigned(value)} Daily Calendar ARP` };
    }
    case ArtifactEffectType.TimeOnSite: {
      return { effect: `${formatSigned(value)} Time on Site ARP` };
    }
    case ArtifactEffectType.DiscordPoll: {
      return { effect: `${formatSigned(value)} Discord Poll ARP` };
    }
    case ArtifactEffectType.MarketDiscountPct: {
      return {
        effect: `${Math.round(Math.abs(value) * 100)}% Game Vault / marketplace discount`,
      };
    }
    case ArtifactEffectType.AllArpPct: {
      return {
        effect: `${formatPct(value)} All ARP`,
        detail:
          value > 0
            ? "Multiplies ARP from activities and claims while equipped."
            : "Reduces All ARP while this is equipped.",
      };
    }
    case ArtifactEffectType.CommunityPlaytimePct: {
      return { effect: `${formatPct(value)} Community Event playtime` };
    }
    default: {
      return { effect: "No ARP bonus" };
    }
  }
}

function describeDefinitionEffect(
  definition: ArtifactDefinition,
  tier: ArtifactTier,
): { effect: string; detail?: string } {
  const raw = definition.effects[tier];
  if (definition.effectType === ArtifactEffectType.UsernameColor) {
    return {
      effect:
        typeof raw === "string" && raw.length > 0
          ? `Username color: ${raw}`
          : "Username color",
    };
  }
  if (definition.effectType === ArtifactEffectType.None) {
    return { effect: "No ARP bonus" };
  }
  if (typeof raw !== "number") {
    return { effect: "No ARP bonus" };
  }
  return describeNumericEffect(definition.effectType, raw);
}

function describeSetEffects(set: ArtifactSetDefinition): string {
  const parts = set.effects.map((effect) => {
    if (effect.unit === "cosmetic") {
      return "username color";
    }
    return describeNumericEffect(effect.type, effect.value).effect;
  });
  return parts.join(", ");
}

function artifactSetForFamily(
  familyId: string,
): ArtifactSetDefinition | undefined {
  return ARTIFACT_SETS.find(
    (set) => set.unconfirmed !== true && set.memberIds.includes(familyId),
  );
}

function artifactTipCopy(
  definition: ArtifactDefinition,
  tier: ArtifactTier,
  displayName: string,
): ArtifactTipCopy {
  const described = describeDefinitionEffect(definition, tier);
  const set = artifactSetForFamily(definition.id);
  const copy: ArtifactTipCopy = {
    title: displayName,
    meta: `${definition.category} · ${TIER_LABELS[tier]}`,
    effect: described.effect,
  };
  if (described.detail) {
    copy.detail = described.detail;
  }
  if (set) {
    copy.setBonus = `Set: ${set.name} — ${describeSetEffects(set)} when all 3 are equipped`;
  }
  return copy;
}

function artifactTipSpan(copy: ArtifactTipCopy, visibleName: string): string {
  const detailAttribute = copy.detail
    ? ` data-tip-detail="${escapeHtml(copy.detail)}"`
    : "";
  const bonusAttribute = copy.setBonus
    ? ` data-tip-set="${escapeHtml(copy.setBonus)}"`
    : "";
  const aria = [copy.title, copy.meta, copy.effect, copy.detail, copy.setBonus]
    .filter((part): part is string => Boolean(part))
    .join(". ");
  return `<span class="ao-artifact-tip" data-tip-title="${escapeHtml(copy.title)}" data-tip-meta="${escapeHtml(copy.meta)}" data-tip-effect="${escapeHtml(copy.effect)}"${detailAttribute}${bonusAttribute} aria-label="${escapeHtml(aria)}">${escapeHtml(visibleName)}</span>`;
}

function nextArtifactNameMatch(
  text: string,
  entries: readonly ArtifactNameEntry[],
): { index: number; entry: ArtifactNameEntry } | undefined {
  let match: { index: number; entry: ArtifactNameEntry } | undefined;
  for (const entry of entries) {
    const index = text.indexOf(entry.name);
    if (index === -1) {
      continue;
    }
    if (
      !match ||
      index < match.index ||
      (index === match.index && entry.name.length > match.entry.name.length)
    ) {
      match = { index, entry };
    }
  }
  return match;
}

/**
 * Escape `text` and wrap known artifact display names in hover-tip spans.
 */
export function wrapArtifactNames(text: string): string {
  const entries = listArtifactNameEntries();
  let remaining = text;
  let html = "";
  while (remaining.length > 0) {
    const match = nextArtifactNameMatch(remaining, entries);
    if (!match) {
      html += escapeHtml(remaining);
      break;
    }
    html += escapeHtml(remaining.slice(0, match.index));
    const name = remaining.slice(
      match.index,
      match.index + match.entry.name.length,
    );
    html += artifactTipSpan(
      artifactTipCopy(match.entry.definition, match.entry.tier, name),
      name,
    );
    remaining = remaining.slice(match.index + match.entry.name.length);
  }
  return html;
}

function ensureArtifactTipFloat(): HTMLElement {
  ensureOptimizerStyles();
  let tip = document.querySelector<HTMLElement>(`#${ARTIFACT_TIP_ID}`);
  if (tip) {
    return tip;
  }
  tip = document.createElement("div");
  tip.id = ARTIFACT_TIP_ID;
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

export function hideArtifactTip(): void {
  const tip = document.querySelector<HTMLElement>(`#${ARTIFACT_TIP_ID}`);
  if (!tip) {
    return;
  }
  tip.hidden = true;
  tip.replaceChildren();
}

function renderTipFloat(copy: {
  title: string;
  meta: string;
  effect: string;
  detail?: string;
  setBonus?: string;
}): string {
  const detail = copy.detail
    ? `<div class="ao-artifact-tip-detail">${escapeHtml(copy.detail)}</div>`
    : "";
  const bonusHtml = copy.setBonus
    ? `<div class="ao-artifact-tip-set">${escapeHtml(copy.setBonus)}</div>`
    : "";
  return `
    <div class="ao-artifact-tip-name">${escapeHtml(copy.title)}</div>
    <div class="ao-artifact-tip-meta">${escapeHtml(copy.meta)}</div>
    <div class="ao-artifact-tip-effect">${escapeHtml(copy.effect)}</div>
    ${detail}
    ${bonusHtml}
  `;
}

function showArtifactTip(trigger: HTMLElement): void {
  const title = trigger.dataset.tipTitle;
  const meta = trigger.dataset.tipMeta;
  const effect = trigger.dataset.tipEffect;
  if (!title || !meta || !effect) {
    return;
  }
  const tip = ensureArtifactTipFloat();
  tip.innerHTML = renderTipFloat({
    title,
    meta,
    effect,
    ...(trigger.dataset.tipDetail && { detail: trigger.dataset.tipDetail }),
    ...(trigger.dataset.tipSet && { setBonus: trigger.dataset.tipSet }),
  });
  tip.hidden = false;
  const gap = 8;
  const rect = trigger.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let top = rect.bottom + gap;
  let left = rect.left;
  if (top + tipRect.height > window.innerHeight - gap) {
    top = rect.top - tipRect.height - gap;
  }
  if (left + tipRect.width > window.innerWidth - gap) {
    left = window.innerWidth - tipRect.width - gap;
  }
  if (left < gap) {
    left = gap;
  }
  if (top < gap) {
    top = gap;
  }
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
}

function tipTriggerFrom(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }
  const trigger = target.closest(".ao-artifact-tip");
  return trigger instanceof HTMLElement ? trigger : undefined;
}

const boundTipRoots = new WeakSet<EventTarget>();

function bindWindowTipDismiss(): void {
  if (document.documentElement.dataset.aoTipWatch === "1") {
    return;
  }
  document.documentElement.dataset.aoTipWatch = "1";
  window.addEventListener("scroll", hideArtifactTip, { capture: true });
  window.addEventListener("resize", hideArtifactTip);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideArtifactTip();
    }
  });
}

/**
 * Hover/focus a floating tip for `.ao-artifact-tip` names inside `root`
 * (light DOM or a shadow root). Safe to call more than once.
 */
export function bindArtifactTips(root: EventTarget): void {
  if (boundTipRoots.has(root)) {
    return;
  }
  boundTipRoots.add(root);
  bindWindowTipDismiss();

  root.addEventListener("pointerover", (event) => {
    if (!(event instanceof PointerEvent)) {
      return;
    }
    const trigger = tipTriggerFrom(event.target);
    if (trigger) {
      showArtifactTip(trigger);
    }
  });
  root.addEventListener("pointerout", (event) => {
    if (!(event instanceof PointerEvent)) {
      return;
    }
    const from = tipTriggerFrom(event.target);
    const to = tipTriggerFrom(event.relatedTarget);
    if (from && from !== to) {
      hideArtifactTip();
    }
  });
}
