export function pageText(document_: Document = document): string {
  return document_.body?.textContent ?? '';
}

function isElementDisplayNone(element: Element): boolean {
  const styleAttribute = element.getAttribute('style') ?? '';
  if (/display:\s*none/i.test(styleAttribute)) {
    return true;
  }
  if (element instanceof HTMLElement && element.style.display === 'none') {
    return true;
  }
  return false;
}

export function isElementVisiblyHidden(element: Element): boolean {
  if (isElementDisplayNone(element) || element.hasAttribute('hidden')) {
    return true;
  }
  if (element.getAttribute('aria-hidden') === 'true') {
    return true;
  }
  const className = element.getAttribute('class') ?? '';
  if (/\b(d-none|hidden|hide|invisible)\b/i.test(className)) {
    return true;
  }
  const view = element.ownerDocument.defaultView;
  if (view && element instanceof view.HTMLElement) {
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return true;
    }
  }
  return false;
}

export function controlLabel(element: Element): string {
  return (element.textContent ?? '').replaceAll(/\s+/g, ' ').trim();
}

export function findActivityCard(
  document_: Document,
  title: RegExp,
): Element | undefined {
  const header = [...document_.querySelectorAll('h2, h3, h4')].find((element) =>
    title.test(element.textContent?.trim() ?? ''),
  );
  if (!header) {
    return undefined;
  }
  return (
    header.closest(
      '.user-profile__profile-card, .aa-card, [class*="profile-card"]',
    ) ??
    header.parentElement?.parentElement ??
    undefined
  );
}

export function utcDateString(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function parseTimestamp(value: string | undefined): number {
  if (!value) {
    return Number.NaN;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}
