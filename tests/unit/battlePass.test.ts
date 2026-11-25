import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  battlePassClaimButtonLabel,
  battlePassControlCenterPath,
  battlePassPathFromDocument,
  battlePassSeasonId,
  discoverBattlePassPath,
  hasBattlePassStartUi,
  isBattlePassDocumentReady,
  isPublicBattlePassSeasonPage,
  mergeBattlePassScrape,
  newerBattlePassPath,
  scrapeBattlePassFromDocument,
  type BattlePassState,
} from '../../src/artifacts/siteState/battlePass';

class FakeElement {
  tag = 'div';

  className = '';

  attrs: Record<string, string> = {};

  dataset: Record<string, string> = {};

  text = '';

  children: FakeElement[] = [];

  parent: FakeElement | undefined;

  value = '';

  private descendantsMatching(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matchesSimple(selector)) {
          found.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  private matchesSimple(selector: string): boolean {
    const tag = /^[a-z][\w-]*/.exec(selector)?.[0];
    if (tag && this.tag !== tag) {
      return false;
    }
    const classes = selector
      .matchAll(/\.([\w-]+)/g)
      .map((match) => match[1])
      .toArray();
    const own = new Set(this.className.split(/\s+/).filter(Boolean));
    if (classes.some((className) => !className || !own.has(className))) {
      return false;
    }
    const attributes = selector
      .matchAll(/\[([\w-]+)(?:\*="([^"]*)"|="([^"]*)")?\]/g)
      .toArray();
    return attributes.every((match) => {
      const name = match[1];
      const value = name === undefined ? undefined : this.attrs[name];
      if (value === undefined) {
        return false;
      }
      const contains = match[2];
      if (contains !== undefined) {
        return value.includes(contains);
      }
      const exact = match[3];
      return exact === undefined || value === exact;
    });
  }

  private elementsMatching(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const alternative of selector.split(',')) {
      const steps = alternative.trim().split(/\s+/).filter(Boolean);
      let layer: FakeElement[] = [this];
      for (const step of steps) {
        layer = layer.flatMap((node) => node.descendantsMatching(step));
      }
      found.push(...layer);
    }
    return found;
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  getAttribute(name: string): string | undefined {
    return name === 'class' ? this.className : (this.attrs[name] ?? undefined);
  }

  matches(selector: string): boolean {
    return selector.split(',').some((part) => this.matchesSimple(part.trim()));
  }

  querySelector(selector: string): FakeElement | undefined {
    return this.elementsMatching(selector)[0];
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.elementsMatching(selector);
  }

  closest(selector: string): FakeElement | undefined {
    if (this.matches(selector)) {
      return this;
    }
    return this.parent?.closest(selector);
  }
}

function element(
  tag: string,
  className: string,
  options: {
    attrs?: Record<string, string>;
    text?: string;
    children?: FakeElement[];
    value?: string;
  } = {},
): FakeElement {
  const node = new FakeElement();
  node.tag = tag;
  node.className = className;
  node.attrs = { ...options.attrs };
  node.text = options.text ?? '';
  node.value = options.value ?? '';
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!name.startsWith('data-')) {
      continue;
    }

    const key = name
      .slice('data-'.length)
      .replaceAll(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    node.dataset[key] = value;
  }
  const children = options.children ?? [];
  for (const child of children) {
    child.parent = node;
    node.children.push(child);
  }
  return node;
}

function asDocument(root: FakeElement, bodyText?: string): Document {
  return {
    body: { textContent: bodyText ?? root.textContent },
    querySelector: (selector: string) =>
      (root.matches(selector) ? root : root.querySelector(selector)) ??
      undefined,
    querySelectorAll: (selector: string) => [
      ...(root.matches(selector) ? [root] : []),
      ...root.querySelectorAll(selector),
    ],
  } as unknown as Document;
}

function linkDocument(links: { href: string; widget?: boolean }[]): Document {
  const anchors = links.map((link) => {
    const anchor = element('a', link.widget ? 'bp-widget__rewards-btn' : '', {
      attrs: { href: link.href },
    });
    return link.widget
      ? element('div', 'bp-widget', { children: [anchor] })
      : anchor;
  });
  return asDocument(element('div', '', { children: anchors }));
}

function passState(url: string, readyToClaimArp = 1): BattlePassState {
  return {
    readyToClaim: readyToClaimArp,
    readyToClaimArp,
    url,
    scrapedAt: '2026-09-30T00:00:00.000Z',
  };
}

beforeAll(() => {
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('document', {
    querySelector: () => {},
    querySelectorAll: () => [],
  });
});

describe('battle pass season path', () => {
  it('maps public and control-center urls onto the personal track', () => {
    expect(battlePassSeasonId('/battle-pass/2')).toBe(2);
    expect(
      battlePassSeasonId(
        'https://na.alienwarearena.com/control-center/battle-pass/2',
      ),
    ).toBe(2);
    expect(battlePassControlCenterPath('/battle-pass/12')).toBe(
      '/control-center/battle-pass/12',
    );
    expect(battlePassSeasonId('/control-center')).toBeUndefined();
  });

  it('prefers the homepage widget over an older battle pass link', () => {
    const document_ = linkDocument([
      { href: '/battle-pass/1' },
      { href: '/battle-pass/2', widget: true },
    ]);
    expect(battlePassPathFromDocument(document_)).toBe(
      '/control-center/battle-pass/2',
    );
  });

  it('uses the highest linked season when the widget is absent', () => {
    const document_ = linkDocument([
      { href: '/control-center/battle-pass/2' },
      { href: '/battle-pass/4' },
    ]);
    expect(battlePassPathFromDocument(document_)).toBe(
      '/control-center/battle-pass/4',
    );
  });

  it('does not step back to an older control-center link', () => {
    const document_ = linkDocument([{ href: '/battle-pass/2', widget: true }]);
    expect(
      newerBattlePassPath('/control-center/battle-pass/3', document_),
    ).toBe('/control-center/battle-pass/3');
    expect(
      newerBattlePassPath('/control-center/battle-pass/1', document_),
    ).toBe('/control-center/battle-pass/2');
  });
});

describe('public battle pass season page', () => {
  it('accepts the rewards page and rejects login redirects and 404s', () => {
    expect(
      isPublicBattlePassSeasonPage({
        ok: true,
        finalUrl: 'https://www.alienwarearena.com/battle-pass/2',
        html: '<div class="bp-landing bp-landing--static">',
      }),
    ).toBe(true);
    expect(
      isPublicBattlePassSeasonPage({
        ok: true,
        finalUrl: 'https://www.alienwarearena.com/login',
        html: '<div class="bp-popup"></div>',
      }),
    ).toBe(false);
    expect(
      isPublicBattlePassSeasonPage({
        ok: false,
        finalUrl: 'https://www.alienwarearena.com/battle-pass/3',
        html: 'Page not found',
      }),
    ).toBe(false);
  });
});

describe('discoverBattlePassPath', () => {
  it('walks past an ended season to the next live pass', async () => {
    const path = await discoverBattlePassPath({
      knownUrl: '/control-center/battle-pass/1',
      force: true,
      isLiveSeason: async (seasonId) => seasonId === 2,
    });
    expect(path).toBe('/control-center/battle-pass/2');
  });

  it('keeps looking one season past a live page and stops on the first miss', async () => {
    const seen: number[] = [];
    const path = await discoverBattlePassPath({
      knownUrl: '/control-center/battle-pass/2',
      force: true,
      isLiveSeason: async (seasonId) => {
        seen.push(seasonId);
        return seasonId === 2 || seasonId === 3;
      },
    });
    expect(path).toBe('/control-center/battle-pass/3');
    expect(seen).toEqual([2, 3, 4]);
  });

  it('keeps the known path when probes find nothing newer', async () => {
    const path = await discoverBattlePassPath({
      knownUrl: '/battle-pass/2',
      force: true,
      isLiveSeason: async () => false,
    });
    expect(path).toBe('/control-center/battle-pass/2');
  });
});

describe('scrapeBattlePassFromDocument', () => {
  it('ignores the logged-out rewards map so it cannot zero out claims', () => {
    const popup = element('div', 'bp-popup', {
      attrs: { 'data-milestone-id': '40' },
    });
    const root = element('div', 'bp-landing bp-landing--static', {
      children: [popup],
    });
    expect(
      scrapeBattlePassFromDocument(asDocument(root), '/battle-pass/2'),
    ).toBeUndefined();
  });

  it('treats popup shells without claim/claimed UI as not loaded', () => {
    const popup = element('div', 'bp-popup', {
      attrs: { 'data-milestone-id': '40' },
    });
    const root = element('div', 'bp-landing bp-landing--personal', {
      children: [popup],
    });
    const document_ = asDocument(root);
    expect(isBattlePassDocumentReady(document_)).toBe(false);
    expect(
      scrapeBattlePassFromDocument(
        document_,
        '/control-center/battle-pass/2',
      ),
    ).toBeUndefined();
  });

  it('detects Start Battle Pass before enrollment', () => {
    const csrf = element('input', '', {
      attrs: { name: '_csrf_token' },
      value: 'start-token',
    });
    const button = element('button', 'bp-header__start-btn', {
      text: 'Start Battle Pass',
    });
    const form = element('form', '', {
      attrs: { action: '/battle-pass/start/3' },
      children: [csrf, button],
    });
    const root = element('div', 'bp-landing bp-landing--personal', {
      children: [form],
    });
    const document_ = asDocument(root);
    expect(hasBattlePassStartUi(document_)).toBe(true);
    expect(isBattlePassDocumentReady(document_)).toBe(true);
    const state = scrapeBattlePassFromDocument(
      document_,
      '/control-center/battle-pass/3',
    );
    expect(state?.needsStart).toBe(true);
    expect(state?.readyToClaim).toBe(0);
    expect(state?.startTarget?.startPath).toBe('/battle-pass/start/3');
    expect(state?.startTarget?.csrfToken).toBe('start-token');
  });

  it('lets a newer season needsStart replace the previous season', () => {
    const previous = passState('/control-center/battle-pass/2', 3);
    const nextSeason: BattlePassState = {
      ...passState('/control-center/battle-pass/3', 0),
      needsStart: true,
      startTarget: { startPath: '/battle-pass/start/3', csrfToken: 'x' },
    };
    expect(mergeBattlePassScrape(nextSeason, previous).needsStart).toBe(true);
    expect(mergeBattlePassScrape(nextSeason, previous).url).toBe(
      '/control-center/battle-pass/3',
    );
  });

  it('is ready when claimed markers exist even with zero CLAIM buttons', () => {
    const claimed = element('div', 'bp-popup__claimed', { text: 'COMPLETE' });
    const popup = element('div', 'bp-popup', {
      attrs: { 'data-milestone-id': '40' },
      children: [claimed],
    });
    const root = element('div', 'bp-landing bp-landing--personal', {
      children: [popup],
    });
    const document_ = asDocument(root);
    expect(isBattlePassDocumentReady(document_)).toBe(true);
    const state = scrapeBattlePassFromDocument(
      document_,
      '/control-center/battle-pass/2',
    );
    expect(state?.readyToClaim).toBe(0);
    expect(state?.url).toBe('/control-center/battle-pass/2');
  });

  it('reads the personal track: season url, token counters, and countdown', () => {
    const title = element('h3', 'bp-popup__title', { text: 'ARP Boost' });
    const csrf = element('input', '', {
      attrs: { name: '_csrf_token' },
      value: 'token',
    });
    const button = element('button', 'bp-popup__claim-btn', { text: 'CLAIM' });
    const form = element('form', '', {
      attrs: { action: '/battle-pass/claim/99', 'data-milestone-id': '40' },
      children: [csrf, button],
    });
    const popup = element('div', 'bp-popup', {
      attrs: { 'data-milestone-id': '40' },
      children: [title, form],
    });
    const countdown = element('strong', 'bp-header__countdown', {
      attrs: { 'data-countdown': '2026-10-26T20:00:00+00:00' },
    });
    const tokenCount = element('strong', 'bp-header__token-count', {
      text: '0',
    });
    const tokenTotal = element('strong', 'bp-header__token-total', {
      text: '150',
    });
    const root = element('div', 'bp-landing bp-landing--personal', {
      children: [tokenCount, tokenTotal, countdown, popup],
    });
    const state = scrapeBattlePassFromDocument(
      asDocument(root, 'BATTLE TOKENS 0/150'),
      'https://na.alienwarearena.com/control-center/battle-pass/2',
    );
    expect(state?.url).toBe('/control-center/battle-pass/2');
    expect(state?.readyToClaim).toBe(1);
    expect(state?.readyToClaimArp).toBe(1);
    expect(state?.endsAt).toBe('2026-10-26T20:00:00.000Z');
    expect(state?.tokens).toBe(0);
    expect(state?.tokensMax).toBe(150);
    expect(state?.readyClaims?.[0]?.claimPath).toBe('/battle-pass/claim/99');
  });

  it('counts ARP Mega Boost as ARP, not a cosmetic', () => {
    const flatTitle = element('h3', 'bp-popup__title', { text: '25 ARP' });
    const flatButton = element('button', 'bp-popup__claim-btn', {
      text: 'CLAIM',
    });
    const flatForm = element('form', '', {
      attrs: { action: '/battle-pass/claim/1', 'data-milestone-id': '75' },
      children: [flatButton],
    });
    const flatPopup = element('div', 'bp-popup', {
      attrs: { 'data-milestone-id': '75' },
      children: [flatTitle, flatForm],
    });
    const megaTitle = element('h3', 'bp-popup__title', {
      text: '50 ARP Mega Boost',
    });
    const megaButton = element('button', 'bp-popup__claim-btn', {
      text: 'CLAIM',
    });
    const megaForm = element('form', '', {
      attrs: { action: '/battle-pass/claim/2', 'data-milestone-id': '91' },
      children: [megaButton],
    });
    const megaPopup = element('div', 'bp-popup', {
      attrs: { 'data-milestone-id': '91' },
      children: [megaTitle, megaForm],
    });
    const cosmeticTitle = element('h3', 'bp-popup__title', {
      text: 'GRIS Border',
    });
    const cosmeticButton = element('button', 'bp-popup__claim-btn', {
      text: 'CLAIM',
    });
    const cosmeticForm = element('form', '', {
      attrs: { action: '/battle-pass/claim/3', 'data-milestone-id': '50' },
      children: [cosmeticButton],
    });
    const cosmeticPopup = element('div', 'bp-popup', {
      attrs: { 'data-milestone-id': '50' },
      children: [cosmeticTitle, cosmeticForm],
    });
    const state = scrapeBattlePassFromDocument(
      asDocument(
        element('div', 'bp-landing bp-landing--personal', {
          children: [flatPopup, megaPopup, cosmeticPopup],
        }),
      ),
      '/control-center/battle-pass/3',
    );
    expect(state?.readyToClaim).toBe(3);
    expect(state?.readyToClaimArp).toBe(2);
    expect(state?.readyClaims?.filter((claim) => claim.isArp)).toHaveLength(2);
    expect(
      state?.readyClaims?.find((claim) => claim.milestoneId === '91')?.isArp,
    ).toBe(true);
  });

  it('uses the account-menu link from Control Center', () => {
    const link = element('a', 'um-nav-link', {
      attrs: { href: '/control-center/battle-pass/2' },
      text: 'Battle Pass',
    });
    const older = element('a', '', { attrs: { href: '/battle-pass/1' } });
    const document_ = asDocument(
      element('div', '', { children: [older, link] }),
    );
    expect(battlePassPathFromDocument(document_)).toBe(
      '/control-center/battle-pass/2',
    );
  });

  it('does not let an older season replace the current one', () => {
    const current = passState('/control-center/battle-pass/2', 3);
    const ended = passState('/control-center/battle-pass/1', 0);
    expect(mergeBattlePassScrape(ended, current)).toBe(current);
    expect(
      mergeBattlePassScrape(
        passState('/control-center/battle-pass/4', 2),
        current,
      ).url,
    ).toBe('/control-center/battle-pass/4');
  });

  it('keeps previous ready claims when a remote scrape is sparse zero', () => {
    const current: BattlePassState = {
      ...passState('/control-center/battle-pass/2', 3),
      readyClaims: [
        {
          milestoneId: '40',
          isArp: true,
          claimPath: '/battle-pass/claim/99',
        },
      ],
    };
    const remoteEmpty = passState('/control-center/battle-pass/2', 0);
    expect(
      mergeBattlePassScrape(remoteEmpty, current, { source: 'remote' }),
    ).toBe(current);
  });

  it('lets a live visit zero out ready claims after claiming', () => {
    const current = passState('/control-center/battle-pass/2', 3);
    const afterClaim = passState('/control-center/battle-pass/2', 0);
    expect(
      mergeBattlePassScrape(afterClaim, current, { source: 'visit' }),
    ).toEqual(afterClaim);
  });

  it('labels skip-ARP claim buttons as non-ARP, not bare Claim rewards', () => {
    expect(battlePassClaimButtonLabel(true)).toMatch(/non-ARP/i);
    expect(battlePassClaimButtonLabel(true)).toMatch(/hold Boosts/i);
    expect(battlePassClaimButtonLabel(true, { compact: true })).toBe(
      'Claim non-ARP',
    );
    expect(battlePassClaimButtonLabel(false)).toBe('Claim all');
  });
});
