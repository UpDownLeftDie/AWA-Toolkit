import { GM } from "$";

import { readPageFragmentBalance } from "../pageGlobals";
import {
  type ArtifactCategory,
  ArtifactTier,
  displayNameFor,
  fragmentCostToUpgradeFrom,
  getArtifactById,
  resolveArtifactByDisplayName,
} from "./data";
import { syncSlotLocksFromScrape } from "./settings";

const SNAPSHOT_KEY = "artifactSnapshot";

export type ArtifactSlotIndex = 1 | 2 | 3;

export interface OwnedArtifact {
  /**
	Site instance id (data-id).
	*/
  instanceId: number;
  familyId: string;
  displayName: string;
  tier: ArtifactTier;
  category: ArtifactCategory;
  upgradeCost?: number;
  maxLevel: boolean;
  /**
	Equipped slot 1|2|3, or omitted if unequipped.
	*/
  equippedPosition?: ArtifactSlotIndex;
  /**
	True when the equipped showcase/modal marks this slot as 24h-locked.
	*/
  slotLocked?: boolean;
  perkDescription: string;
}

export interface ArtifactSnapshot {
  scrapedAt: string;
  username: string | undefined;
  fragments: number;
  artifacts: OwnedArtifact[];
  /**
	Per-slot lock state from the Showroom showcase / equip modal.
	*/
  slotLocks?: Partial<Record<ArtifactSlotIndex, boolean>>;
}

function isArtifactSnapshot(value: unknown): value is ArtifactSnapshot {
  if (typeof value !== "object" || !value) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return Array.isArray(v.artifacts) && typeof v.fragments === "number";
}

export async function loadSnapshot(): Promise<ArtifactSnapshot | undefined> {
  const raw: string | ArtifactSnapshot | undefined =
    await GM.getValue(SNAPSHOT_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return isArtifactSnapshot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function saveSnapshot(snapshot: ArtifactSnapshot): Promise<void> {
  await GM.setValue(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

/**
 * Apply a successful AWA upgrade to the cached showroom snapshot so the
 * optimizer does not keep recommending the old tier until the 6h rescrape.
 */
export async function applySnapshotUpgrade(
  instanceId: number,
): Promise<ArtifactSnapshot | undefined> {
  const snapshot = await loadSnapshot();
  if (!snapshot) {
    return;
  }
  const current = snapshot.artifacts.find(
    (artifact) => artifact.instanceId === instanceId,
  );
  if (!current || current.tier >= ArtifactTier.Interstellar) {
    return snapshot;
  }
  const toTier = (current.tier + 1) as ArtifactTier;
  const family = getArtifactById(current.familyId);
  const cost =
    current.upgradeCost ?? fragmentCostToUpgradeFrom(current.tier) ?? 0;
  const upgraded: OwnedArtifact = {
    ...current,
    tier: toTier,
    displayName: family ? displayNameFor(family, toTier) : current.displayName,
    maxLevel: toTier === ArtifactTier.Interstellar,
  };
  const nextCost = fragmentCostToUpgradeFrom(toTier);
  if (nextCost === undefined) {
    delete upgraded.upgradeCost;
  } else {
    upgraded.upgradeCost = nextCost;
  }
  const next: ArtifactSnapshot = {
    ...snapshot,
    scrapedAt: new Date().toISOString(),
    fragments: Math.max(0, snapshot.fragments - cost),
    artifacts: snapshot.artifacts.map((artifact) =>
      artifact.instanceId === instanceId ? upgraded : artifact,
    ),
  };
  await saveSnapshot(next);
  return next;
}

function readFragmentBalance(document_: Document): number {
  const fromPage = readPageFragmentBalance(document_);
  if (fromPage !== undefined) {
    return fromPage;
  }
  const text = document_.body?.textContent ?? "";
  const match = /Fragments:\s*([\d,]+)/i.exec(text);
  if (match?.[1]) {
    return Number(match[1].replaceAll(",", ""));
  }
  return 0;
}

function readUsernameFrom(
  document_: Document,
  pathHint?: string,
): string | undefined {
  const pathMatch = /\/member\/([^/]+)\/artifacts/.exec(
    pathHint ?? location.pathname,
  );
  if (pathMatch?.[1]) {
    return pathMatch[1];
  }
  const link = document_.querySelector<HTMLAnchorElement>(
    'a[href*="/member/"][href$="/artifacts"]',
  );
  const hrefMatch = link
    ? /\/member\/([^/]+)\/artifacts/.exec(link.getAttribute("href") ?? "")
    : undefined;
  return hrefMatch?.[1];
}

function readUsername(): string | undefined {
  return readUsernameFrom(document);
}

/**
 * Site redirect to the logged-in user's Artifact Showroom
 * (`/member/<you>/artifacts`).
 */
export const USER_ARTIFACTS_ROOM_PATH = "/user-artifacts-room";

/**
 * Artifact Showroom path for the logged-in user.
 * Falls back to `/user-artifacts-room`, which the site redirects.
 */
export function resolveShowroomUrl(username?: string | undefined): string {
  const name = username ?? readUsername();
  if (name) {
    return `/member/${encodeURIComponent(name)}/artifacts`;
  }
  const link = document.querySelector<HTMLAnchorElement>(
    'a[href*="/member/"][href$="/artifacts"]',
  );
  if (link?.pathname) {
    return link.pathname;
  }
  return USER_ARTIFACTS_ROOM_PATH;
}

function parseEquippedPosition(card: Element): ArtifactSlotIndex | undefined {
  const unequip = card.parentElement?.querySelector<HTMLButtonElement>(
    'button[onclick*="unequipArtifact"]',
  );
  if (!unequip) {
    return undefined;
  }
  const match = /unequipArtifact\s*\(\s*\d+\s*,\s*([123])\s*\)/.exec(
    unequip.getAttribute("onclick") ?? "",
  );
  if (!match?.[1]) {
    return undefined;
  }
  return Number(match[1]) as ArtifactSlotIndex;
}

function normalizeName(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim().toLowerCase();
}

interface ShowcaseSlot {
  position: ArtifactSlotIndex;
  displayName: string;
  isLocked: boolean;
}

/**
 * Prefer explicit unlock icons. Font Awesome uses `fa-lock-open` (not a
 * `fa-lock` token), so "has fa-lock and not fa-lock-open" is the locked state.
 */
function isShowcaseSlotLocked(slot: Element): boolean {
  if (slot.querySelector(":scope i.fa-lock-open, :scope i.fa-unlock")) {
    return false;
  }
  return Boolean(slot.querySelector(":scope i.fa-lock"));
}

/**
 * Hero showcase slots expose equipped artifacts + lock icons even when Unequip
 * is hidden during the 24h cooldown.
 */
function scrapeShowcaseSlots(document_: Document): ShowcaseSlot[] {
  const root = document_.querySelector(".slots");
  const slots = root
    ? [...root.querySelectorAll(":scope > .slot")]
    : [...document_.querySelectorAll(".slot")];
  const result: ShowcaseSlot[] = [];
  let position = 1 as ArtifactSlotIndex;
  for (const slot of slots) {
    if (position > 3) {
      break;
    }
    const img =
      slot.querySelector<HTMLImageElement>(":scope .slot-front img") ??
      slot.querySelector<HTMLImageElement>(":scope img");
    const displayName = (img?.alt ?? "").trim();
    if (!displayName || /^artifact$/i.test(displayName)) {
      position = (position + 1) as ArtifactSlotIndex;
      continue;
    }
    result.push({
      position,
      displayName,
      isLocked: isShowcaseSlotLocked(slot),
    });
    position = (position + 1) as ArtifactSlotIndex;
  }
  return result;
}

/**
Showcase lock icons are the source of truth for slot cooldowns.
*/
function applyShowcaseEquips(
  artifacts: OwnedArtifact[],
  showcase: ShowcaseSlot[],
): Partial<Record<ArtifactSlotIndex, boolean>> {
  const slotLocks: Partial<Record<ArtifactSlotIndex, boolean>> = {
    1: false,
    2: false,
    3: false,
  };

  for (const slot of showcase) {
    slotLocks[slot.position] = slot.isLocked;
    const match = artifacts.find(
      (artifact) =>
        normalizeName(artifact.displayName) === normalizeName(slot.displayName),
    );
    if (!match) {
      continue;
    }
    match.equippedPosition = slot.position;
    match.slotLocked = slot.isLocked;
  }

  return slotLocks;
}

function parseFooterTier(card: Element): ArtifactTier | undefined {
  const tip =
    card.querySelector<HTMLImageElement>("img[data-original-title]")?.dataset
      .originalTitle ?? "";
  const footerMatch =
    /(Weapon|Clothing|Power|Language|Precious Gems|Tech|Knowledge|Social|Architecture)\s*-\s*(Rust|Bronze|Silver|Gold|Platinum|Interstellar)/i.exec(
      tip,
    );
  const tierLabel = footerMatch?.[2]?.toLowerCase();
  if (!tierLabel) {
    return undefined;
  }
  const map: Record<string, ArtifactTier> = {
    rust: ArtifactTier.Rust,
    bronze: ArtifactTier.Bronze,
    silver: ArtifactTier.Silver,
    gold: ArtifactTier.Gold,
    platinum: ArtifactTier.Platinum,
    interstellar: ArtifactTier.Interstellar,
  };
  return map[tierLabel];
}

/**
 * Scrape an Artifact Showroom Document into a snapshot.
 */
export function scrapeShowroomFromDocument(
  document_: Document,
  pathHint?: string,
): ArtifactSnapshot {
  const cards = document_.querySelectorAll<HTMLAnchorElement>(
    "a.artifact-list-item.change-artifact-modal",
  );

  const artifacts: OwnedArtifact[] = [];

  for (const card of cards) {
    const instanceId = Number(card.dataset.id);
    if (Number.isNaN(instanceId)) {
      continue;
    }

    const displayName = (card.dataset.title ?? "").trim();
    if (!displayName) {
      continue;
    }

    const resolved = resolveArtifactByDisplayName(displayName);
    const footerTier = parseFooterTier(card);
    const tier = resolved?.tier ?? footerTier;
    if (tier === undefined || !resolved) {
      console.warn("[Artifact Optimizer] Unrecognized artifact:", displayName);
      continue;
    }

    const upgradeCostRaw = card.dataset.upgradeCost;
    const parsedUpgradeCost =
      upgradeCostRaw === undefined || upgradeCostRaw === ""
        ? undefined
        : Number(upgradeCostRaw);
    const upgradeCost = Number.isNaN(parsedUpgradeCost as number)
      ? undefined
      : parsedUpgradeCost;
    const isMaxLevel =
      card.dataset.maxLevel === "true" ||
      card.dataset.maxLevel === "1" ||
      upgradeCost === 0;

    const owned: OwnedArtifact = {
      instanceId,
      familyId: resolved.definition.id,
      displayName,
      tier,
      category: resolved.definition.category,
      maxLevel: isMaxLevel,
      perkDescription: card.dataset.descriptionPerk ?? "",
    };
    if (upgradeCost !== undefined) {
      owned.upgradeCost = upgradeCost;
    }
    const equippedPosition = parseEquippedPosition(card);
    if (equippedPosition !== undefined) {
      owned.equippedPosition = equippedPosition;
    }
    artifacts.push(owned);
  }

  const showcase = scrapeShowcaseSlots(document_);
  const slotLocks = applyShowcaseEquips(artifacts, showcase);

  return {
    scrapedAt: new Date().toISOString(),
    username: readUsernameFrom(document_, pathHint),
    fragments: readFragmentBalance(document_),
    artifacts,
    slotLocks,
  };
}

export function scrapeShowroom(): ArtifactSnapshot {
  return scrapeShowroomFromDocument(document, location.pathname);
}

export function isShowroomDocumentReady(document_: Document): boolean {
  return Boolean(
    document_.querySelector(
      "a.artifact-list-item.change-artifact-modal, #weapon-section",
    ),
  );
}

export async function waitForShowroomDocument(
  timeoutMs = 12_000,
): Promise<void> {
  if (isShowroomDocumentReady(document)) {
    return;
  }
  await new Promise<void>((resolve) => {
    let isSettled = false;
    const observer = new MutationObserver(() => {
      if (isShowroomDocumentReady(document)) {
        finish();
      }
    });
    const timer = setTimeout(finish, timeoutMs);
    function finish(): void {
      if (isSettled) {
        return;
      }
      isSettled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });
}

export async function scrapeAndPersist(): Promise<ArtifactSnapshot> {
  if (!isShowroomDocumentReady(document)) {
    await waitForShowroomDocument();
  }
  if (!isShowroomDocumentReady(document)) {
    const existing = await loadSnapshot();
    if (existing) {
      return existing;
    }
  }
  const snapshot = scrapeShowroom();
  if (snapshot.artifacts.length === 0) {
    const existing = await loadSnapshot();
    if (existing && existing.artifacts.length > 0) {
      return existing;
    }
  }
  await saveSnapshot(snapshot);
  await syncSlotLocksFromScrape(snapshot.slotLocks ?? {});
  return snapshot;
}

export function isArtifactsShowroomPage(): boolean {
  return (
    /\/member\/[^/]+\/artifacts\/?$/.test(location.pathname) ||
    /\/user-artifacts-room\/?$/.test(location.pathname)
  );
}
