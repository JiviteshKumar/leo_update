import type { TargetInfo } from './types';

// Ids that look machine-generated (hashes, React ids, numeric suffixes from
// list renderers) break on the next deploy, so they rank below stable hooks.
const looksGenerated = (id: string): boolean =>
  /[0-9a-f]{6,}/i.test(id) || /\d{3,}/.test(id) || /^:/.test(id) || id.length > 40;

const cssEscape = (v: string): string => CSS.escape(v);

const isUnique = (selector: string): boolean => {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
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

const nthOfTypePath = (el: Element, maxDepth = 8): string => {
  const segments: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && segments.length < maxDepth) {
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    // An ancestor with a usable id anchors the path and keeps it short.
    if (node !== el && node.id && !looksGenerated(node.id)) {
      segments.unshift(`#${cssEscape(node.id)}`);
      break;
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

// Ranked candidate selectors for an element. Unique matches at record time
// rank first; the `:text=` pseudo (same convention the replayer resolves) is
// the resilient fallback when attributes churn.
export const generateSelectors = (el: Element): string[] => {
  const tag = el.tagName.toLowerCase();
  const raw: string[] = [];

  if (el.id && !looksGenerated(el.id)) raw.push(`#${cssEscape(el.id)}`);

  for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
    const v = el.getAttribute(attr);
    if (v) raw.push(`[${attr}="${cssEscape(v)}"]`);
  }

  for (const attr of ['name', 'aria-label', 'placeholder']) {
    const v = el.getAttribute(attr);
    if (v) raw.push(`${tag}[${attr}="${cssEscape(v)}"]`);
  }

  const type = el.getAttribute('type');
  if (tag === 'input' && type) raw.push(`input[type="${cssEscape(type)}"]`);

  if (tag === 'a') {
    const href = el.getAttribute('href');
    if (href && href !== '#' && !href.startsWith('javascript:')) {
      raw.push(`a[href="${cssEscape(href)}"]`);
    }
  }

  const text = visibleText(el);
  if (text && ['a', 'button', 'label', 'span', 'div', 'li'].includes(tag)) {
    raw.push(`${tag}:text=${text.slice(0, 40)}`);
  }
  if (el.getAttribute('role') === 'button' && text) {
    raw.push(`[role="button"]:text=${text.slice(0, 40)}`);
  }

  raw.push(nthOfTypePath(el));

  const unique = raw.filter((s) => !s.includes(':text=') && isUnique(s));
  const rest = raw.filter((s) => !unique.includes(s));
  return [...new Set([...unique, ...rest])].slice(0, 8);
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
