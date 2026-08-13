import { giveawayKeyStatus } from "../pageGlobals";

export const OFFICIAL_GIVEAWAYS_PATH = "/ucf/Giveaway";
const ESI_GIVEAWAY_PATH = "/esi/featured-tile-data/Giveaway";
const MAX_ESI_PAGES = 10;

export interface OfficialGiveaway {
  id: string;
  title: string;
  url: string;
  isClaimed?: boolean;
}

const SHOW_GIVEAWAY_HREF =
  /\/ucf\/show\/(\d+)\/(?:[\w.-]+\/)*Giveaway\/([\w.-]+)/i;
const LISTING_PATH = /\/ucf\/Giveaway\/?$/i;
const IFRAME_WAIT_MS = 15_000;
const IFRAME_SETTLE_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function titleFromSlug(slug: string): string {
  const words = slug.replaceAll("-", " ").trim();
  if (!words) {
    return "New giveaway";
  }
  return words.replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

function titleFromCard(element: HTMLElement): string {
  const heading = element.querySelector(
    "h1, h2, h3, h4, .giveaways__listing-post-title, .post-title, .tile-title",
  );
  const headingText = heading?.textContent?.replaceAll(/\s+/g, " ").trim();
  if (headingText) {
    return headingText;
  }
  const titled = element.title.trim();
  if (titled) {
    return titled;
  }
  return "";
}

function giveawayFromHref(
  href: string,
  title: string,
): OfficialGiveaway | undefined {
  const match = SHOW_GIVEAWAY_HREF.exec(href);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const id = match[1];
  const slug = match[2];
  return {
    id,
    title: title || titleFromSlug(slug),
    url: new URL(`/ucf/show/${id}/Giveaway/${slug}`, location.origin).href,
  };
}

function addGiveaway(
  found: Map<string, OfficialGiveaway>,
  href: string,
  title: string,
): void {
  const giveaway = giveawayFromHref(href, title);
  if (!giveaway) {
    return;
  }
  const existing = found.get(giveaway.id);
  if (!existing || giveaway.title.length > existing.title.length) {
    found.set(giveaway.id, giveaway);
  }
}

function withClaimed(
  giveaway: OfficialGiveaway,
  isClaimed: boolean | undefined,
): OfficialGiveaway {
  if (isClaimed !== true) {
    return giveaway;
  }
  return { ...giveaway, isClaimed: true };
}

function mergeGiveaways(
  groups: readonly OfficialGiveaway[][],
): OfficialGiveaway[] {
  const found = new Map<string, OfficialGiveaway>();
  for (const group of groups) {
    for (const giveaway of group) {
      const existing = found.get(giveaway.id);
      const isClaimed =
        existing?.isClaimed === true || giveaway.isClaimed === true;
      if (!existing || giveaway.title.length > existing.title.length) {
        found.set(giveaway.id, withClaimed(giveaway, isClaimed));
      } else if (isClaimed) {
        found.set(giveaway.id, withClaimed(existing, true));
      }
    }
  }
  return found.values().toArray();
}

export function isOfficialGiveawayListingPath(path: string): boolean {
  return LISTING_PATH.test(path);
}

function scrapeGiveawayFromPath(
  pathOrUrl: string,
  title = "",
): OfficialGiveaway | undefined {
  return giveawayFromHref(pathOrUrl, title);
}

export function scrapeOfficialGiveawaysFromDocument(
  document_: Document,
): OfficialGiveaway[] {
  const found = new Map<string, OfficialGiveaway>();

  for (const post of document_.querySelectorAll<HTMLElement>(
    '.giveaways__listing-post, [data-url-link*="/ucf/show/"]',
  )) {
    const href = post.dataset.urlLink ?? "";
    addGiveaway(found, href, titleFromCard(post));
  }

  for (const link of document_.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/ucf/show/"][href*="/Giveaway/"]',
  )) {
    addGiveaway(
      found,
      link.href,
      link.textContent?.replaceAll(/\s+/g, " ").trim() ?? "",
    );
  }

  const html = document_.documentElement?.getHTML() ?? "";
  const hrefMatches = html.matchAll(
    new RegExp(SHOW_GIVEAWAY_HREF.source, "gi"),
  );
  for (const match of hrefMatches) {
    if (match[0]) {
      addGiveaway(found, match[0], "");
    }
  }

  return found.values().toArray();
}

function scrapeLiveGiveaways(): OfficialGiveaway[] {
  const listing = isOfficialGiveawayListingPath(location.pathname)
    ? scrapeOfficialGiveawaysFromDocument(document)
    : [];
  const pageTitle =
    document
      .querySelector("h1, .ucf-title, .content-title")
      ?.textContent?.replaceAll(/\s+/g, " ")
      .trim() ??
    document.title.split("|", 1)[0]?.trim() ??
    "";
  const current = scrapeGiveawayFromPath(location.pathname, pageTitle);
  return mergeGiveaways([listing, current ? [current] : []]);
}

interface EsiGiveawayItem {
  id?: number | string;
  title?: string;
  name?: string;
  url?: string;
  slug?: string;
}

function esiItemsFromPayload(data: unknown): EsiGiveawayItem[] {
  if (Array.isArray(data)) {
    return data as EsiGiveawayItem[];
  }
  if (typeof data === "object" && data && "data" in data) {
    const nested = (data as { data: unknown }).data;
    if (Array.isArray(nested)) {
      return nested as EsiGiveawayItem[];
    }
  }
  return [];
}

function officialGiveawayFromEsi(
  item: EsiGiveawayItem,
): OfficialGiveaway | undefined {
  if (item.id === undefined) {
    return undefined;
  }
  const id = String(item.id);
  const title =
    (item.title ?? item.name ?? "").trim() || titleFromSlug(item.slug ?? "");
  let url: string;
  if (item.url) {
    url = new URL(item.url, location.origin).href;
  } else if (item.slug) {
    url = new URL(`/ucf/show/${id}/Giveaway/${item.slug}`, location.origin)
      .href;
  } else {
    url = new URL(`/ucf/show/${id}/`, location.origin).href;
  }
  const giveaway: OfficialGiveaway = { id, title, url };
  if (giveawayKeyStatus(id)?.status === "assigned") {
    giveaway.isClaimed = true;
  }
  return giveaway;
}

async function fetchEsiGiveawayPage(page: number): Promise<EsiGiveawayItem[]> {
  const response = await fetch(`${ESI_GIVEAWAY_PATH}/${page}`, {
    headers: {
      Accept: "*/*",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!response.ok) {
    throw new Error(`ESI Giveaway page ${page} failed (${response.status})`);
  }
  return esiItemsFromPayload(await response.json());
}

async function loadGiveawaysFromEsi(): Promise<OfficialGiveaway[]> {
  const found: OfficialGiveaway[] = [];
  for (let page = 1; page <= MAX_ESI_PAGES; page += 1) {
    let items: EsiGiveawayItem[];
    try {
      items = await fetchEsiGiveawayPage(page);
    } catch (error) {
      if (page === 1) {
        throw error;
      }
      break;
    }
    if (items.length === 0) {
      break;
    }
    for (const item of items) {
      const giveaway = officialGiveawayFromEsi(item);
      if (giveaway) {
        found.push(giveaway);
      }
    }
  }
  return mergeGiveaways([found]);
}

async function fetchGiveawayDocument(
  path: string,
): Promise<Document | undefined> {
  try {
    const response = await fetch(path, {
      headers: { Accept: "text/html" },
    });
    if (!response.ok) {
      return undefined;
    }
    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  } catch (error) {
    console.warn("[AWA Toolkit] Giveaway listing fetch failed:", error);
    return undefined;
  }
}

async function openGiveawayListingFrame(): Promise<Document | undefined> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText =
      "position:fixed;width:1px;height:1px;left:-9999px;top:0;opacity:0;pointer-events:none;border:0";
    const cleanup = (): void => {
      iframe.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, IFRAME_WAIT_MS);
    iframe.addEventListener("load", () => {
      clearTimeout(timer);
      void delay(IFRAME_SETTLE_MS).then(() => {
        const document_ = iframe.contentDocument ?? undefined;
        cleanup();
        resolve(document_);
      });
    });
    iframe.addEventListener("error", () => {
      clearTimeout(timer);
      cleanup();
      resolve(undefined);
    });
    document.body.append(iframe);
    iframe.src = OFFICIAL_GIVEAWAYS_PATH;
  });
}

/**
 * Official key giveaways. Prefer the same ESI JSON the homepage tiles use;
 * `/ucf/Giveaway` HTML is a hydrated listing and is often empty over fetch.
 * Community giveaways are a different listing and are ignored.
 */
export async function loadOfficialGiveaways(): Promise<OfficialGiveaway[]> {
  const live = scrapeLiveGiveaways();
  try {
    const fromEsi = await loadGiveawaysFromEsi();
    if (fromEsi.length > 0) {
      return mergeGiveaways([fromEsi, live]);
    }
  } catch (error) {
    console.warn("[AWA Toolkit] ESI giveaway list failed:", error);
  }

  if (isOfficialGiveawayListingPath(location.pathname) && live.length > 0) {
    return live;
  }

  const fetched = await fetchGiveawayDocument(OFFICIAL_GIVEAWAYS_PATH);
  const fromFetch = fetched ? scrapeOfficialGiveawaysFromDocument(fetched) : [];
  if (fromFetch.length > 0) {
    return mergeGiveaways([fromFetch, live]);
  }

  const framed = await openGiveawayListingFrame();
  const fromFrame = framed ? scrapeOfficialGiveawaysFromDocument(framed) : [];
  return mergeGiveaways([fromFrame, live]);
}
