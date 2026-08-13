import { GM } from "$";

import { getArtifactSettings } from "../settings";
import { findActivityCard } from "../siteState/shared";
import { showAoAlert, showAoToast } from "./dialog";

const QUESTS_PATH = "/quests";
const TWITCH_HOST = /(^|\.)twitch\.tv$/i;

export type TwitchStreamGroup = "hive" | "nexus" | "partner";

export type TwitchPickReason =
  "preferred" | "doubleArpDrops" | "doubleArp" | "drops" | "random";

export interface TwitchStream {
  login: string;
  displayName: string;
  title: string;
  url: string;
  group: TwitchStreamGroup;
}

export interface TwitchPick {
  stream: TwitchStream;
  reason: TwitchPickReason;
}

function twitchLoginFromHref(href: string): string | undefined {
  try {
    const url = new URL(href, location.origin);
    if (!TWITCH_HOST.test(url.hostname)) {
      return undefined;
    }
    const login = url.pathname.replace(/^\//, "").split("/", 1)[0];
    if (!login) {
      return undefined;
    }
    return login.toLowerCase();
  } catch {
    return undefined;
  }
}

function headingGroup(text: string): TwitchStreamGroup | undefined {
  const label = text.replaceAll(/\s+/g, " ").trim();
  if (/^hive\b/i.test(label)) {
    return "hive";
  }
  if (/^nexus\b/i.test(label)) {
    return "nexus";
  }
  if (/^partners?\b/i.test(label)) {
    return "partner";
  }
  return undefined;
}

function twitchWatchUrl(href: string, login: string): string {
  try {
    const url = new URL(href, location.origin);
    if (TWITCH_HOST.test(url.hostname)) {
      return url.href;
    }
  } catch {
    // Non-Twitch or unparsable href from the quests row.
  }
  return `https://www.twitch.tv/${login}`;
}

function streamFromRow(
  row: Element,
  group: TwitchStreamGroup,
): TwitchStream | undefined {
  const link = row.querySelector('a[href*="twitch.tv"]');
  const href = link?.getAttribute("href") ?? "";
  const login = twitchLoginFromHref(href);
  if (!login) {
    return undefined;
  }
  const details = row.querySelector(".quest-list__quest-details");
  const nameText =
    [...(details?.children ?? [])].find(
      (child) => !child.classList.contains("small"),
    )?.textContent ??
    row.querySelector("img")?.getAttribute("alt") ??
    link?.textContent;
  const title =
    details
      ?.querySelector(".small")
      ?.textContent?.replaceAll(/\s+/g, " ")
      .trim() ?? "";
  const displayName = nameText?.replaceAll(/\s+/g, " ").trim() || login;
  return {
    login,
    displayName,
    title,
    url: twitchWatchUrl(href, login),
    group,
  };
}

export function scrapeLiveTwitchStreams(document_: Document): TwitchStream[] {
  const card = findActivityCard(document_, /^Watch Twitch$/i);
  if (!card) {
    return [];
  }
  const body = card.querySelector(".user-profile__card-body") ?? card;
  const streams: TwitchStream[] = [];
  const seen = new Set<string>();
  let group: TwitchStreamGroup = "partner";

  for (const node of body.querySelectorAll(
    ".card-table-heading, .card-table-row",
  )) {
    if (node.classList.contains("card-table-heading")) {
      group = headingGroup(node.textContent ?? "") ?? group;
      continue;
    }
    const stream = streamFromRow(node, group);
    if (!stream || seen.has(stream.login)) {
      continue;
    }
    seen.add(stream.login);
    streams.push(stream);
  }
  return streams;
}

function pickRandom<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  const index = (bytes[0] ?? 0) % items.length;
  return items[index];
}

function hasDropsInTitle(stream: TwitchStream): boolean {
  return /drops/i.test(stream.title);
}

function isDoubleArp(stream: TwitchStream): boolean {
  return stream.group === "hive" || stream.group === "nexus";
}

function isPreferredMatch(
  stream: TwitchStream,
  preferredLogin: string,
): boolean {
  if (stream.login === preferredLogin) {
    return true;
  }
  return (
    stream.displayName.replaceAll(/\s+/g, "").toLowerCase() === preferredLogin
  );
}

function pickFromPool(
  streams: readonly TwitchStream[],
  reason: Exclude<TwitchPickReason, "preferred">,
  isMatch: (stream: TwitchStream) => boolean,
): TwitchPick | undefined {
  const stream = pickRandom(streams.filter((candidate) => isMatch(candidate)));
  if (!stream) {
    return undefined;
  }
  return { stream, reason };
}

export function pickTwitchStream(
  streams: readonly TwitchStream[],
  preferredLogins: readonly string[],
): TwitchPick | undefined {
  if (streams.length === 0) {
    return undefined;
  }

  for (const preferred of preferredLogins) {
    const stream = streams.find((candidate) =>
      isPreferredMatch(candidate, preferred),
    );
    if (stream) {
      return { stream, reason: "preferred" };
    }
  }

  return (
    pickFromPool(
      streams,
      "doubleArpDrops",
      (stream) => isDoubleArp(stream) && hasDropsInTitle(stream),
    ) ??
    pickFromPool(streams, "doubleArp", isDoubleArp) ??
    pickFromPool(streams, "drops", hasDropsInTitle) ??
    pickFromPool(streams, "random", () => true)
  );
}

function doubleArpGroupLabel(stream: TwitchStream): string {
  return stream.group === "nexus" ? "Nexus" : "Hive";
}

function pickReasonLabel(pick: TwitchPick): string {
  if (pick.reason === "preferred") {
    return "preferred";
  }
  if (pick.reason === "doubleArpDrops") {
    return `${doubleArpGroupLabel(pick.stream)}, 2x ARP, drops`;
  }
  if (pick.reason === "doubleArp") {
    return `${doubleArpGroupLabel(pick.stream)}, 2x ARP`;
  }
  if (pick.reason === "drops") {
    return "drops";
  }
  return "random";
}

function isQuestsPage(): boolean {
  let path = location.pathname;
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  return path.endsWith("/quests") && !path.includes("/steam/quests");
}

async function loadTwitchStreamsDocument(): Promise<Document | undefined> {
  if (isQuestsPage()) {
    return document;
  }
  try {
    const response = await fetch(QUESTS_PATH, {
      headers: { Accept: "text/html" },
    });
    if (!response.ok) {
      return undefined;
    }
    return new DOMParser().parseFromString(await response.text(), "text/html");
  } catch (error) {
    console.warn("[AWA Toolkit] Failed to fetch Twitch streams", error);
    return undefined;
  }
}

export async function handleOpenTwitchStream(): Promise<void> {
  const settings = await getArtifactSettings();
  const questsDocument = await loadTwitchStreamsDocument();
  if (!questsDocument) {
    await showAoAlert(
      "Could not load the Quests page to find live Twitch streams.",
    );
    return;
  }
  const streams = scrapeLiveTwitchStreams(questsDocument);
  const pick = pickTwitchStream(streams, settings.preferredTwitchStreamers);
  if (!pick) {
    await showAoAlert(
      "No live participating Twitch streams were listed. Try again when someone is online.",
    );
    return;
  }
  showAoToast(`Opening ${pick.stream.displayName} (${pickReasonLabel(pick)})`);
  await GM.openInTab(pick.stream.url, { active: true });
}

export function bindOpenTwitchButtons(root: ParentNode): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    ".ao-twitch-btn",
  )) {
    button.addEventListener("click", () => {
      if (button.disabled) {
        return;
      }
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = "Picking…";
      void handleOpenTwitchStream().finally(() => {
        button.disabled = false;
        button.textContent = previous ?? "Open stream";
      });
    });
  }
}
