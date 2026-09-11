import type { TargetInfo } from './types';

// Selector generation (record time) and resolution (replay time).
//
// Conventions shared by both sides:
//  - `base:text=needle` — Playwright-style text pseudo: the visible element
//    matching `base` whose text is `needle` (exact match preferred).
//  - `host >>> inner` — pierces an open shadow root: `host` is resolved in
//    the document, `inner` inside host.shadowRoot. Chains for nested roots.

const SHADOW = ' >>> ';

// Ids that look machine-generated (hashes, React ids, numeric suffixes from
// list renderers) break on the next deploy, so they rank below stable hooks.
const looksGenerated = (id: string): boolean =>
  /[0-9a-f]{6,}/i.test(id) || /\d{3,}/.test(id) || /^:/.test(id) || id.length > 40;

// CSS.escape is for identifiers (ids, class names). For a value inside a
// quoted attribute selector only the quote and backslash need escaping —
// using CSS.escape there would mangle spaces, '#', etc. into '\ ' / '\#'.
const cssEscape = (v: string): string => CSS.escape(v);
const attrValue = (v: string): string => v.replace(/["\\]/g, '\\$&');

type Scope = Document | ShadowRoot;

const scopeOf = (el: Element): Scope => {
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root : document;
};

const isUniqueIn = (scope: Scope, selector: string): boolean => {
  try {
    return scope.querySelectorAll(selector).length === 1;
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
const ANCHOR_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id', 'aria-label', 'name'];

// A selector that pins `el` on its own, if it carries a stable identifier.
const stableAnchor = (el: Element): string | null => {
  const tag = el.tagName.toLowerCase();
  if (el.id && !looksGenerated(el.id)) return `#${cssEscape(el.id)}`;
  for (const attr of ANCHOR_ATTRS) {
    const v = el.getAttribute(attr);
    if (v && !looksGenerated(v)) return `${tag}[${attr}="${attrValue(v)}"]`;
  }
  return null;
};

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();

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
  return normalize(text).slice(0, 60);
};

// Human-readable label for a form field: its <label>, aria-label,
// placeholder, or name. Used for intents and secret-step prompts.
export const fieldLabel = (el: Element): string => {
  const input = el as HTMLInputElement;
  if (input.labels?.length) {
    const t = input.labels[0].innerText?.trim();
    if (t) return normalize(t).slice(0, 60);
  }
  const named =
    el.getAttribute('aria-label')?.trim() ||
    el.getAttribute('placeholder')?.trim() ||
    el.getAttribute('data-placeholder')?.trim() ||
    el.getAttribute('name')?.trim();
  if (named) return named;
  // A rich-text editor's text is what the user typed into it, not its name.
  if ((el as HTMLElement).isContentEditable) return 'text editor';
  return visibleText(el) || el.tagName.toLowerCase();
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
      // Top of the document or of a shadow tree.
      segments.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
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

// Ranked selectors for `el` within its own scope (document or shadow root).
const localSelectors = (el: Element): string[] => {
  const scope = scopeOf(el);
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
    if (attr.startsWith('data-') && !['data-testid', 'data-test', 'data-qa', 'data-cy'].includes(attr)) {
      const v = el.getAttribute(attr);
      if (v && v.length <= 40 && !looksGenerated(v)) raw.push(`${tag}[${attr}="${attrValue(v)}"]`);
    }
  }
  for (const attr of ['role', 'title', 'alt', 'type']) {
    const v = el.getAttribute(attr);
    if (v && (attr !== 'type' || tag === 'input')) raw.push(`${tag}[${attr}="${attrValue(v)}"]`);
  }

  // Stable class hooks, combined for specificity (svg.calendar-icon.large).
  const classes = Array.from(el.classList).filter(isStableClass).slice(0, 3);
  if (classes.length) raw.push(`${tag}${classes.map((c) => `.${cssEscape(c)}`).join('')}`);

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
    if (href && href !== '#' && !href.startsWith('javascript:')) raw.push(`a[href="${attrValue(href)}"]`);
  }

  const text = visibleText(el);
  if (text && ['a', 'button', 'label', 'span', 'div', 'li'].includes(tag)) {
    raw.push(`${tag}:text=${text.slice(0, 40)}`);
  }
  if (el.getAttribute('role') === 'button' && text) raw.push(`[role="button"]:text=${text.slice(0, 40)}`);

  // Anchor a lenient and a precise path on the nearest identifiable ancestor,
  // then the whole-tree positional path as the last resort.
  const anchored = anchoredDescendant(el);
  if (anchored) raw.push(anchored);
  raw.push(nthOfTypePath(el));

  const unique = raw.filter((s) => !s.includes(':text=') && isUniqueIn(scope, s));
  const rest = raw.filter((s) => !unique.includes(s));
  return [...new Set([...unique, ...rest])];
};

// Ranked candidate selectors for an element, up to 10. Elements inside open
// shadow roots get `host >>> inner` chains.
export const generateSelectors = (el: Element): string[] => {
  const local = localSelectors(el);
  const root = el.getRootNode();
  if (!(root instanceof ShadowRoot)) return local.slice(0, 10);
  // Resolve the host structurally (text selectors on a host would match its
  // whole shadow content), then combine with the best inner selectors.
  const hosts = generateSelectors(root.host)
    .filter((s) => !s.split(SHADOW).pop()!.includes(':text='))
    .slice(0, 2);
  const out: string[] = [];
  for (const inner of local.slice(0, 5)) for (const host of hosts) out.push(`${host}${SHADOW}${inner}`);
  return out.slice(0, 10);
};

const frameParentPath = (): string[] => {
  if (window.top === window) return [];
  return [location.origin + location.pathname];
};

export const buildTarget = (el: Element, action: string): TargetInfo => {
  const tag = el.tagName.toLowerCase();
  const text = visibleText(el);
  const label = fieldLabel(el);

  const editable = (el as HTMLElement).isContentEditable;
  const inputType = tag === 'input' ? (el as HTMLInputElement).type : '';

  let intent: string;
  if (action === 'type') intent = `Type into the "${label}" field`;
  else if (action === 'select') intent = `Choose an option in the "${label}" dropdown`;
  else if (action === 'upload') intent = `Choose a file for the "${label}" field`;
  // A checkbox's "text" is its value ("on"); name it by its label instead.
  else if (action === 'drag') intent = text ? `Drag "${text}"` : `Drag the ${tag} element`;
  else if (action === 'drop') intent = text ? `Drop onto "${text}"` : `Drop onto the ${tag} element`;
  else if (inputType === 'checkbox') intent = `Toggle the "${label}" checkbox`;
  else if (inputType === 'radio') intent = `Select the "${label}" option`;
  else if (editable) intent = `Click into the "${label}"`;
  else intent = text ? `Click "${text}"` : `Click the ${tag} element`;

  const parent = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host as HTMLElement | undefined);
  const context = parent
    ? normalize((parent as HTMLElement).innerText ?? '').slice(0, 200)
    : undefined;

  // Form fields change their text while being typed into (value), so only
  // keep text for elements that are recognised by it.
  const isField = ['input', 'textarea', 'select'].includes(tag) || editable;
  return {
    selectors: generateSelectors(el),
    tag,
    text: (isField ? el.getAttribute('placeholder') || el.getAttribute('aria-label') || '' : text) || undefined,
    intent,
    context: context || undefined,
    framePath: frameParentPath(),
  };
};

// ---------------------------------------------------------------------------
// Resolution (replay side)
// ---------------------------------------------------------------------------

export const isVisible = (el: Element): boolean => {
  const html = el as HTMLElement;
  if (!html.getClientRects || html.getClientRects().length === 0) return false;
  const style = getComputedStyle(html);
  return style.visibility !== 'hidden' && style.display !== 'none';
};

// Every element matching `selector` in the document and in all open shadow
// roots below it (the healer and agent must see web-component internals).
export const deepQueryAll = (selector: string, scope: Scope = document): Element[] => {
  const out: Element[] = [];
  const walk = (s: Scope) => {
    try {
      out.push(...Array.from(s.querySelectorAll(selector)));
    } catch {
      return;
    }
    for (const el of Array.from(s.querySelectorAll('*'))) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(scope);
  return out;
};

// Visible elements matching `base` whose text contains `needle`; an exact
// match wins, otherwise the tightest (shortest-text) container — so
// "Save" prefers a "Save" button over a "Save draft" button or a wrapper div.
const byText = (scope: Scope, base: string, needleRaw: string, allowHidden = false): Element | null => {
  const needle = normalize(needleRaw).toLowerCase();
  let best: Element | null = null;
  let bestLen = Infinity;
  for (const n of Array.from(scope.querySelectorAll(base || '*'))) {
    const text = normalize((n as HTMLElement).innerText || n.textContent || '').toLowerCase();
    if (!text.includes(needle) || (!allowHidden && !isVisible(n))) continue;
    if (text === needle) return n;
    if (text.length < bestLen) {
      best = n;
      bestLen = text.length;
    }
  }
  return best;
};

// Resolve one selector (with >>> and :text= support) to a visible element
// (or, with allowHidden, to one that exists but isn't shown).
export const resolveSelector = (selector: string, allowHidden = false): Element | null => {
  const parts = selector.split(SHADOW);
  let scope: Scope = document;
  try {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      const textMatch = /^(.*?):text=(.+)$/.exec(part);
      let el: Element | null;
      if (textMatch) el = byText(scope, textMatch[1], textMatch[2], allowHidden && last);
      else el = scope.querySelector(part);
      if (!el) return null;
      if (last) return allowHidden || isVisible(el) ? el : null;
      if (!el.shadowRoot) return null;
      scope = el.shadowRoot;
    }
  } catch {
    // invalid CSS; skip
  }
  return null;
};

// Weak selectors (positional paths, loose descendant/class matches) can land
// on a different element after a redesign. Those matches must still look
// like the recorded element before replay acts on them.
const isWeak = (selector: string): boolean => {
  const last = selector.split(SHADOW).pop()!;
  return (
    last.includes(':nth-of-type') ||
    / [a-z]/i.test(last.replace(/\[[^\]]*\]/g, '')) ||
    /^[a-z]+(\.[\w-]+)+$/i.test(last)
  );
};

export const plausibleMatch = (el: Element, target: TargetInfo): boolean => {
  if (el.tagName.toLowerCase() !== target.tag) return false;
  const isField = ['input', 'textarea', 'select'].includes(target.tag);
  if (isField || !target.text) return true;
  const now = normalize(visibleText(el)).toLowerCase();
  const then = normalize(target.text).toLowerCase();
  return now === then || now.includes(then) || (now.length > 0 && then.includes(now));
};

// Replay: the element a recorded target points at, or null. With
// allowHidden, a present-but-hidden element (a closed menu's item) counts,
// matched by strong selectors only.
export const findTarget = (target: TargetInfo, opts: { allowHidden?: boolean } = {}): Element | null => {
  for (const sel of target.selectors) {
    if (opts.allowHidden && isWeak(sel)) continue;
    const el = resolveSelector(sel, opts.allowHidden);
    if (!el) continue;
    if (isWeak(sel) && !plausibleMatch(el, target)) continue;
    return el;
  }
  return null;
};

// Back-compat helper: first visible match among `selectors`.
export const trySelector = <T extends Element>(selectors: string[]): T | null => {
  for (const sel of selectors) {
    const el = resolveSelector(sel);
    if (el) return el as T;
  }
  return null;
};

export const matchesFrame = (framePath: string[]): boolean => {
  const own = frameParentPath();
  if (framePath.length === 0) return own.length === 0;
  if (own.length === 0) return false;
  // Compare on origin + pathname so query params churn doesn't break frames.
  return own[own.length - 1] === framePath[framePath.length - 1];
};

// The innermost element at a viewport point, descending into open shadow
// roots (document.elementFromPoint stops at the shadow host).
export const deepElementFromPoint = (x: number, y: number): Element | null => {
  let el = document.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
};

// `ancestor` contains `node`, crossing shadow boundaries.
export const composedContains = (ancestor: Element, node: Node | null): boolean => {
  let n: Node | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null);
  }
  return false;
};
