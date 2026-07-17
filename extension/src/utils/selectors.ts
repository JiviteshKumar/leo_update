import type { TargetInfo } from './types';

// Ids that look machine-generated (hashes, React ids, numeric suffixes from
// list renderers) break on the next deploy, so they rank below stable hooks.
const looksGenerated = (id: string): boolean =>
  /[0-9a-f]{6,}/i.test(id) || /\d{3,}/.test(id) || /^:/.test(id) || id.length > 40;

// CSS.escape is for identifiers (ids, class names). For a value inside a
// quoted attribute selector only the quote and backslash need escaping —
// using CSS.escape there would mangle spaces, '#', etc. into '\ ' / '\#'.
const cssEscape = (v: string): string => CSS.escape(v);
const attrValue = (v: string): string => v.replace(/["\\]/g, '\\$&');

const isUnique = (selector: string): boolean => {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
};

// Class tokens that read as human-authored hooks (calendar-icon, datepicker)
// rather than utilities (w-4), hashes (css-1a2b3c) or CSS-module names
// (Button_root__x7f9). Digits/underscores are the usual tell for the churny
// ones, so we keep letter/hyphen tokens of a reasonable length.
const isStableClass = (c: string): boolean =>
  c.length >= 4 && c.length <= 30 && /^[a-z][a-z-]+$/i.test(c);

// Attributes that identify an element the way a human would recognise it.
// data-testid & friends first (test hooks), then a11y/name attributes; the
// generic data-* sweep in generateSelectors covers app-specific ones.
const ANCHOR_ATTRS = [
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'data-id',
  'aria-label',
  'name',
];

// A selector that pins `el` on its own, if it carries a stable identifier.
// Used both to emit a direct selector and to anchor positional paths so they
// stop at the nearest recognisable ancestor instead of the document root.
const stableAnchor = (el: Element): string | null => {
  const tag = el.tagName.toLowerCase();
  if (el.id && !looksGenerated(el.id)) return `#${cssEscape(el.id)}`;
  for (const attr of ANCHOR_ATTRS) {
    const v = el.getAttribute(attr);
    if (v && !looksGenerated(v)) return `${tag}[${attr}="${attrValue(v)}"]`;
  }
  return null;
};

export const visibleText = (el: Element): string => {
  const html = el as HTMLElement;
  const text =
    html.innerText?.trim() ||
    el.getAttribute('aria-label')?.trim() ||
    el.getAttribute('placeholder')?.trim() ||
    el.getAttribute('title')?.trim() ||
    el.getAttribute('alt')?.trim() ||
    (el as HTMLInputElement).value?.trim?.() ||
    '';
  return text.replace(/\s+/g, ' ').slice(0, 60);
};

// Human-readable label for a form field: its <label>, aria-label,
// placeholder, or name. Used for intents and secret-step prompts.
export const fieldLabel = (el: Element): string => {
  const input = el as HTMLInputElement;
  if (input.labels?.length) {
    const t = input.labels[0].innerText?.trim();
    if (t) return t.replace(/\s+/g, ' ').slice(0, 60);
  }
  return (
    el.getAttribute('aria-label')?.trim() ||
    el.getAttribute('placeholder')?.trim() ||
    el.getAttribute('name')?.trim() ||
    visibleText(el) ||
    el.tagName.toLowerCase()
  );
};

const nthOfTypePath = (el: Element, maxDepth = 10): string => {
  const segments: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && segments.length < maxDepth) {
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    // Any ancestor with a stable identifier (id, data-testid, aria-label, …)
    // anchors the path: everything above it is dropped, so unrelated DOM
    // churn higher in the tree can't break the selector.
    if (node !== el) {
      const anchor = stableAnchor(node);
      if (anchor) {
        segments.unshift(anchor);
        break;
      }
    }
    if (!parent) {
      segments.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === node!.tagName,
    );
    const idx = siblings.indexOf(node) + 1;
    segments.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    node = parent;
  }
  return segments.join(' > ');
};

// A lenient anchor→element selector: the nearest stable ancestor plus the
// element's tag joined by a descendant combinator (`[data-x] svg`). Survives
// intermediate wrapper changes that a child-combinator path would not.
const anchoredDescendant = (el: Element, maxUp = 6): string | null => {
  const tag = el.tagName.toLowerCase();
  let node: Element | null = el.parentElement;
  let depth = 0;
  while (node && node !== document.body && depth < maxUp) {
    const anchor = stableAnchor(node);
    if (anchor) return `${anchor} ${tag}`;
    node = node.parentElement;
    depth += 1;
  }
  return null;
};

// Ranked candidate selectors for an element. Unique matches at record time
// rank first; the `:text=` pseudo (same convention the replayer resolves) is
// the resilient fallback when attributes churn.
export const generateSelectors = (el: Element): string[] => {
  const tag = el.tagName.toLowerCase();
  const raw: string[] = [];

  if (el.id && !looksGenerated(el.id)) raw.push(`#${cssEscape(el.id)}`);

  // Test hooks: the most stable identifiers there are. Tag-qualified so a
  // reused value on a different element type still disambiguates.
  for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
    const v = el.getAttribute(attr);
    if (v) raw.push(`${tag}[${attr}="${attrValue(v)}"]`);
  }

  for (const attr of ['name', 'aria-label', 'placeholder']) {
    const v = el.getAttribute(attr);
    if (v) raw.push(`${tag}[${attr}="${attrValue(v)}"]`);
  }

  // Every other app-specific data-* attribute (data-icon, data-action, …),
  // plus a11y/semantic attributes. These are how icons and other
  // attribute-poor controls are usually recognisable.
  for (const attr of el.getAttributeNames()) {
    if (
      attr.startsWith('data-') &&
      !['data-testid', 'data-test', 'data-qa', 'data-cy'].includes(attr)
    ) {
      const v = el.getAttribute(attr);
      if (v && v.length <= 40 && !looksGenerated(v)) {
        raw.push(`${tag}[${attr}="${attrValue(v)}"]`);
      }
    }
  }
  for (const attr of ['role', 'title', 'alt', 'type']) {
    const v = el.getAttribute(attr);
    if (v && (attr !== 'type' || tag === 'input')) {
      raw.push(`${tag}[${attr}="${attrValue(v)}"]`);
    }
  }

  // Stable class hooks, combined for specificity (svg.calendar-icon.large).
  const classes = Array.from(el.classList).filter(isStableClass).slice(0, 3);
  if (classes.length) {
    raw.push(`${tag}${classes.map((c) => `.${cssEscape(c)}`).join('')}`);
  }

  // Icon sprites: <svg> whose <use> points at a named symbol (#icon-calendar).
  if (tag === 'svg') {
    const use = el.querySelector('use');
    const href = use?.getAttribute('href') ?? use?.getAttribute('xlink:href');
    if (href && href.startsWith('#') && !looksGenerated(href)) {
      raw.push(`svg:has(use[href="${attrValue(href)}"])`);
    }
  }

  if (tag === 'a') {
    const href = el.getAttribute('href');
    if (href && href !== '#' && !href.startsWith('javascript:')) {
      raw.push(`a[href="${attrValue(href)}"]`);
    }
  }

  const text = visibleText(el);
  if (text && ['a', 'button', 'label', 'span', 'div', 'li'].includes(tag)) {
    raw.push(`${tag}:text=${text.slice(0, 40)}`);
  }
  if (el.getAttribute('role') === 'button' && text) {
    raw.push(`[role="button"]:text=${text.slice(0, 40)}`);
  }

  // Anchor a lenient and a precise path on the nearest identifiable ancestor,
  // then the whole-tree positional path as the last resort.
  const anchored = anchoredDescendant(el);
  if (anchored) raw.push(anchored);
  raw.push(nthOfTypePath(el));

  const unique = raw.filter((s) => !s.includes(':text=') && isUnique(s));
  const rest = raw.filter((s) => !unique.includes(s));
  return [...new Set([...unique, ...rest])].slice(0, 10);
};

const frameParentPath = (): string[] => {
  if (window.top === window) return [];
  return [location.origin + location.pathname];
};

export const buildTarget = (el: Element, action: string): TargetInfo => {
  const tag = el.tagName.toLowerCase();
  const text = visibleText(el);
  const label = fieldLabel(el);

  let intent: string;
  if (action === 'type') intent = `Type into the "${label}" field`;
  else if (action === 'select') intent = `Choose an option in the "${label}" dropdown`;
  else intent = text ? `Click "${text}"` : `Click the ${tag} element`;

  const context = el.parentElement
    ? (el.parentElement as HTMLElement).innerText
        ?.replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
    : undefined;

  return {
    selectors: generateSelectors(el),
    tag,
    text: text || undefined,
    intent,
    context: context || undefined,
    framePath: frameParentPath(),
  };
};

// ---------------------------------------------------------------------------
// Resolution (replay side)
// ---------------------------------------------------------------------------

// Playwright-inspired `base:text=needle` pseudo. querySelector throws on
// invalid CSS, so every attempt is wrapped; one bad selector never kills the
// list. Adapted from clarity/extension steps/helpers.ts.
export const trySelector = <T extends Element>(
  selectors: string[],
): T | null => {
  for (const sel of selectors) {
    try {
      const textMatch = /^(.*?):text=(.+)$/.exec(sel);
      if (textMatch) {
        const [, base, needleRaw] = textMatch;
        const needle = needleRaw.trim().toLowerCase();
        const nodes = document.querySelectorAll<T>(base || '*');
        for (const n of Array.from(nodes)) {
          const text =
            (n as unknown as HTMLElement).innerText?.toLowerCase() ?? '';
          if (text.includes(needle) && isVisible(n)) return n;
        }
        continue;
      }
      const el = document.querySelector<T>(sel);
      if (el && isVisible(el)) return el;
    } catch {
      // invalid CSS, skip
    }
  }
  return null;
};

export const isVisible = (el: Element): boolean => {
  const html = el as HTMLElement;
  if (!html.getClientRects || html.getClientRects().length === 0) return false;
  const style = getComputedStyle(html);
  return style.visibility !== 'hidden' && style.display !== 'none';
};

export const matchesFrame = (framePath: string[]): boolean => {
  const own = frameParentPath();
  if (framePath.length === 0) return own.length === 0;
  if (own.length === 0) return false;
  // Compare on origin + pathname so query params churn doesn't break frames.
  return own[own.length - 1] === framePath[framePath.length - 1];
};
