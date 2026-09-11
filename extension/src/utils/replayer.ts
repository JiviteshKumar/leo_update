import { LEO_NODE_ATTR, cursorHide, cursorMoveTo, cursorPulse, highlightElement } from './cursor';
import { frameOffset } from './frames';
import {
  composedContains,
  deepElementFromPoint,
  deepQueryAll,
  findTarget,
  generateSelectors,
  isVisible,
  visibleText,
} from './selectors';
import { LEO_UI_HOST } from './types';
import type {
  AgentAction,
  AgentSnapshot,
  Candidate,
  ElementStep,
  ExecResult,
  KeyMods,
  KeyStep,
  LocateResult,
  Step,
  TargetInfo,
} from './types';

// Content-script half of replay. Two input modes:
//  - native (default): locate() finds the element, waits until a real click
//    would land on it, and returns top-level coordinates; the background then
//    clicks/types through the debugger (trusted input).
//  - compatible: execStep() finds the element and dispatches page-level
//    events itself (used when the debugger is unavailable, and for <select>).

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// requestAnimationFrame pauses in background tabs; never wait on it alone.
const nextFrame = () =>
  Promise.race([new Promise<void>((r) => requestAnimationFrame(() => r())), sleep(50)]);

const FIND_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 7_000;

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], ' +
  '[role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], ' +
  '[role="switch"], [onclick], [contenteditable="true"]';

const waitForTarget = async (target: TargetInfo, timeoutMs = FIND_TIMEOUT_MS): Promise<Element | null> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (document.readyState !== 'loading') {
      const el = findTarget(target);
      if (el) return el;
    }
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
};

const describeEl = (el: Element): string => {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : '';
  const text = visibleText(el).slice(0, 30);
  return `<${tag}${id}${cls}>${text ? ` "${text}"` : ''}`;
};

// ---------------------------------------------------------------------------
// Leo's floating menu must never swallow a replayed click
// ---------------------------------------------------------------------------

let uiRestoreTimer: ReturnType<typeof setTimeout> | null = null;

// Hides the floating menu for a moment if it covers (x, y). Top frame only.
export const hideLeoUiAt = (x: number, y: number): boolean => {
  const host = document.querySelector(LEO_UI_HOST) as HTMLElement | null;
  const card = host?.shadowRoot?.querySelector('.leo-float') as HTMLElement | null;
  if (!host || !card) return false;
  const r = card.getBoundingClientRect();
  if (r.width === 0 || x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
  host.style.visibility = 'hidden';
  if (uiRestoreTimer) clearTimeout(uiRestoreTimer);
  uiRestoreTimer = setTimeout(() => {
    host.style.visibility = '';
  }, 1_500);
  return true;
};

// ---------------------------------------------------------------------------
// Actionability — the element is attached, visible, enabled, not moving, and
// a click at its center would reach it (not an overlay, cookie banner, …).
// ---------------------------------------------------------------------------

type Actionable = { ok: true; x: number; y: number } | { ok: false; error: string };

const isDisabled = (el: Element): boolean =>
  (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

const waitActionable = async (el: Element, fast: boolean, timeoutMs = ACTION_TIMEOUT_MS): Promise<Actionable> => {
  const deadline = Date.now() + timeoutMs;
  let reason = 'it never became ready';
  let scrolls = 0;
  for (;;) {
    if (!el.isConnected) return { ok: false, error: 'the element was removed from the page' };
    if (Date.now() >= deadline) return { ok: false, error: `the element can't be clicked: ${reason}` };

    const r = el.getBoundingClientRect();
    if (!isVisible(el) || r.width === 0 || r.height === 0) {
      reason = 'it is not visible';
    } else if (isDisabled(el)) {
      reason = 'it is disabled';
    } else {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
        if (scrolls++ < 5) {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: fast ? 'auto' : 'smooth' });
          await sleep(fast ? 60 : 400);
          continue;
        }
        reason = 'it could not be scrolled into view';
      } else {
        await nextFrame();
        const r2 = el.getBoundingClientRect();
        if (Math.abs(r2.left - r.left) > 1 || Math.abs(r2.top - r.top) > 1) {
          reason = 'it is still moving';
        } else {
          const x = r2.left + r2.width / 2;
          const y = r2.top + r2.height / 2;
          const hit = deepElementFromPoint(x, y);
          if (hit && composedContains(el, hit)) return { ok: true, x, y };
          // An icon with pointer-events:none inside a button: the button
          // receives the click, which is what the user's click did too.
          if (hit && composedContains(hit, el) && hit.matches(INTERACTIVE_SELECTOR)) return { ok: true, x, y };
          // A control inside its own <label> (custom checkboxes).
          if (hit instanceof HTMLLabelElement && hit.control === el) return { ok: true, x, y };
          if (hit && hit.tagName.toLowerCase() === LEO_UI_HOST && hideLeoUiAt(x, y)) continue;
          reason = hit ? `it is covered by ${describeEl(hit)}` : 'it is outside the page';
        }
      }
    }
    await sleep(100);
  }
};

// ---------------------------------------------------------------------------
// Native-input locate + follow-ups
// ---------------------------------------------------------------------------

// The element the last locate returned in this frame; selectAll/verify/
// focus/setValue act on it.
let lastLocated: Element | null = null;

const pointAt = async (el: Element, fast: boolean, withSelectors: boolean): Promise<LocateResult> => {
  const a = await waitActionable(el, fast);
  if (!a.ok) return { ok: false, error: a.error };
  lastLocated = el;
  let off: { x: number; y: number };
  try {
    off = await frameOffset();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!fast) await cursorMoveTo(a.x, a.y);
  cursorPulse(a.x, a.y);
  return {
    ok: true,
    x: Math.round(a.x + off.x),
    y: Math.round(a.y + off.y),
    ...(withSelectors ? { healedSelectors: generateSelectors(el) } : {}),
  };
};

export const locate = async (target: TargetInfo, fast: boolean, timeoutMs?: number): Promise<LocateResult> => {
  const el = await waitForTarget(target, timeoutMs);
  if (!el) {
    return {
      ok: false,
      notFound: true,
      candidates: collectCandidates(),
      pageTitle: document.title,
      pageUrl: location.href,
    };
  }
  return pointAt(el, fast, false);
};

export const locateCandidate = async (index: number, fast: boolean): Promise<LocateResult> => {
  const el = lastCandidates[index];
  if (!el || !el.isConnected) return { ok: false, error: 'the repaired element disappeared before it could be used' };
  return pointAt(el, fast, true);
};

const located = (): HTMLElement | null =>
  lastLocated && lastLocated.isConnected ? (lastLocated as HTMLElement) : null;

// Select the field's current content so typing replaces it.
export const selectAllLocated = (): ExecResult => {
  const el = located();
  if (!el) return { ok: false, error: 'the field is no longer on the page' };
  el.focus();
  if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } else if (typeof (el as HTMLInputElement).select === 'function') {
    try {
      (el as HTMLInputElement).select();
    } catch {
      // some input types don't support selection
    }
  }
  return { ok: true };
};

export const focusLocated = (): ExecResult => {
  const el = located();
  if (!el) return { ok: false, error: 'the element is no longer on the page' };
  el.focus();
  return { ok: true };
};

const currentValue = (el: HTMLElement): string =>
  el.isContentEditable ? (el.textContent ?? '') : ((el as HTMLInputElement).value ?? '');

const short = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

export const verifyLocated = (expected: string): ExecResult => {
  const el = located();
  // The page moved on (e.g. the field was replaced after input); nothing
  // left to check.
  if (!el) return { ok: true };
  const norm = (s: string) => (el.isContentEditable ? s.replace(/\s+/g, ' ').trim() : s);
  const actual = currentValue(el);
  if (norm(actual) === norm(expected)) return { ok: true };
  return { ok: false, error: `the field shows "${short(actual)}" instead of "${short(expected)}"` };
};

export const setLocatedValue = async (value: string): Promise<ExecResult> => {
  const el = located();
  if (!el) return { ok: false, error: 'the field is no longer on the page' };
  await typeInto(el, value, true);
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Settle: wait until the page stops changing
// ---------------------------------------------------------------------------

const isLeoNode = (n: Node): boolean =>
  n instanceof Element && (n.hasAttribute(LEO_NODE_ATTR) || n.tagName.toLowerCase() === LEO_UI_HOST);

export const settle = (quietMs: number, maxMs: number): Promise<{ ok: true }> =>
  new Promise((resolve) => {
    const start = Date.now();
    let last = start;
    const obs = new MutationObserver((records) => {
      const pageChange = records.some(
        (r) =>
          !isLeoNode(r.target) &&
          !(r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(isLeoNode)),
      );
      if (pageChange) last = Date.now();
    });
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const tick = () => {
      const now = Date.now();
      if ((now - last >= quietMs && document.readyState === 'complete') || now - start >= maxMs) {
        obs.disconnect();
        resolve({ ok: true });
      } else {
        setTimeout(tick, 50);
      }
    };
    tick();
  });

// ---------------------------------------------------------------------------
// Compatible mode: page-level events
// ---------------------------------------------------------------------------

// React/Vue controlled inputs ignore direct .value writes; going through the
// prototype setter + input event is the reliable path.
const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void => {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const mouseEventInit = (x: number, y: number): MouseEventInit => ({
  bubbles: true,
  cancelable: true,
  composed: true,
  view: window,
  clientX: x,
  clientY: y,
  button: 0,
});

const dispatchClick = (el: Element, x: number, y: number): void => {
  el.dispatchEvent(new PointerEvent('pointerdown', { ...mouseEventInit(x, y), pointerId: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', mouseEventInit(x, y)));
  el.dispatchEvent(new PointerEvent('pointerup', { ...mouseEventInit(x, y), pointerId: 1 }));
  el.dispatchEvent(new MouseEvent('mouseup', mouseEventInit(x, y)));
  el.dispatchEvent(new MouseEvent('click', mouseEventInit(x, y)));
};

const typeInto = async (el: Element, text: string, fast: boolean): Promise<void> => {
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  (el as HTMLElement).focus?.();

  if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (fast) {
    setNativeValue(input, text);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  // Visible, per-character typing. Each character goes through the native
  // setter so frameworks see every intermediate value.
  setNativeValue(input, '');
  let current = '';
  for (const ch of text) {
    current += ch;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
    setNativeValue(input, current);
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await sleep(text.length > 40 ? 8 : 35);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

const KEY_CODES: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Home: 36, End: 35,
  PageUp: 33, PageDown: 34, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32,
};

const dispatchKey = (el: Element, key: string, mods: KeyMods = {}): void => {
  const keyCode = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const init: KeyboardEventInit = {
    key,
    keyCode,
    which: keyCode,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    bubbles: true,
    cancelable: true,
  };
  const handled = !el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  // Synthetic Enter never triggers native form submission; mirror it
  // manually when no handler claimed the event and it wasn't a shortcut.
  const form = (el as HTMLInputElement).form;
  if (key === 'Enter' && !mods.ctrl && !mods.meta && !mods.alt && !handled && form) form.requestSubmit();
};

const performOn = async (el: Element, step: Step, fast: boolean): Promise<void> => {
  const a = await waitActionable(el, fast);
  if (!a.ok) throw new Error(a.error);
  const { x, y } = a;
  if (!fast) await cursorMoveTo(x, y);
  switch (step.type) {
    case 'click':
      cursorPulse(x, y);
      (el as HTMLElement).focus?.();
      dispatchClick(el, x, y);
      break;
    case 'dblclick':
      cursorPulse(x, y);
      dispatchClick(el, x, y);
      dispatchClick(el, x, y);
      el.dispatchEvent(new MouseEvent('dblclick', mouseEventInit(x, y)));
      break;
    case 'type':
      await typeInto(el, step.text, fast);
      break;
    case 'select': {
      cursorPulse(x, y);
      const select = el as HTMLSelectElement;
      if (Array.from(select.options).some((o) => o.value === step.value)) setNativeValue(select, step.value);
      else {
        const opt = Array.from(select.options).find((o) => o.label === step.label);
        if (!opt) throw new Error(`option not found: ${step.label}`);
        setNativeValue(select, opt.value);
      }
      select.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    case 'key':
      cursorPulse(x, y);
      (el as HTMLElement).focus?.();
      dispatchKey(el, step.key, step.mods);
      break;
    default:
      throw new Error(`unsupported step: ${(step as Step).type}`);
  }
  cursorHide();
};

export const execStep = async (step: ElementStep | KeyStep, fast = false): Promise<ExecResult> => {
  try {
    if (step.type === 'key') {
      // A key press goes to its recorded field when it's still there, else
      // to whatever has focus (usually the field typed into just before).
      const el = step.target ? await waitForTarget(step.target, 3_000) : null;
      const focusTarget = el ?? document.activeElement ?? document.body;
      (focusTarget as HTMLElement).focus?.();
      dispatchKey(focusTarget, step.key, step.mods);
      return { ok: true };
    }
    const el = await waitForTarget(step.target);
    if (!el) {
      return {
        ok: false,
        notFound: true,
        candidates: collectCandidates(),
        pageTitle: document.title,
        pageUrl: location.href,
      };
    }
    await performOn(el, step, fast);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// Execute on an AI-picked candidate from the last collectCandidates() sweep.
// Returns fresh selectors so the background can patch the workflow.
export const execCandidate = async (index: number, step: ElementStep, fast = false): Promise<ExecResult> => {
  try {
    const el = lastCandidates[index];
    if (!el || !el.isConnected) return { ok: false, error: 'healed element disappeared before execution' };
    await performOn(el, step, fast);
    return { ok: true, healedSelectors: generateSelectors(el) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// ---------------------------------------------------------------------------
// Candidate collection for AI healing and the agent
// ---------------------------------------------------------------------------

let lastCandidates: Element[] = [];

const describe = (els: Element[], withRects = false): Candidate[] => {
  lastCandidates = els;
  return els.map((el, index) => {
    const attrs: Record<string, string> = {};
    // `class` is included so the agent can tell otherwise-identical controls
    // apart (e.g. a date picker's prev/next arrow svgs).
    for (const a of ['id', 'name', 'aria-label', 'placeholder', 'type', 'href', 'role', 'title', 'class']) {
      const v = el.getAttribute(a);
      if (v) attrs[a] = v.slice(0, 80);
    }
    const c: Candidate = { index, tag: el.tagName.toLowerCase(), text: visibleText(el).slice(0, 80), attrs };
    if (withRects) {
      const r = el.getBoundingClientRect();
      c.rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return c;
  });
};

// Interactive elements on the page, including inside open shadow roots.
// Leo's own menu is excluded.
const onPage = (el: Element) => isVisible(el) && !el.closest(LEO_UI_HOST);

export const collectCandidates = (): Candidate[] =>
  describe(deepQueryAll(INTERACTIVE_SELECTOR).filter(onPage).slice(0, 150));

// Broader than INTERACTIVE_SELECTOR: the agent must see attribute-poor
// controls too — calendar arrows (bare <svg> with cursor:pointer), custom
// widgets, icon buttons. Anything with a click affordance is fair game.
const AGENT_SELECTOR = INTERACTIVE_SELECTOR + ', svg, [role], [tabindex], [aria-label]';

const hasClickAffordance = (el: Element): boolean => {
  if (el.matches(INTERACTIVE_SELECTOR)) return true;
  if (el.getAttribute('role') || el.getAttribute('aria-label')) return true;
  const ti = el.getAttribute('tabindex');
  if (ti && ti !== '-1') return true;
  // cursor:pointer on the element or its immediate parent is the usual tell
  // for a framework-handled clickable that carries no DOM attribute.
  try {
    if (getComputedStyle(el as HTMLElement).cursor === 'pointer') return true;
    const p = el.parentElement;
    if (p && getComputedStyle(p).cursor === 'pointer') return true;
  } catch {
    // getComputedStyle can throw on detached nodes
  }
  return false;
};

export const agentSnapshot = (): AgentSnapshot => {
  const els = deepQueryAll(AGENT_SELECTOR)
    .filter((el) => onPage(el) && hasClickAffordance(el))
    .slice(0, 150);
  return {
    candidates: describe(els, true),
    pageText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 3000),
    title: document.title,
    url: location.href,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
  };
};

// Native input for an agent action: where to click (top frame coordinates),
// plus fresh selectors for the element so a recovered step can be repaired.
export const agentLocate = async (action: AgentAction): Promise<LocateResult> => {
  if (action.kind === 'scroll') return { ok: false, error: 'scroll has no target' };
  if (action.kind === 'clickAt') {
    const hit = deepElementFromPoint(action.x, action.y);
    const el = (hit?.closest?.(INTERACTIVE_SELECTOR) as Element | null) ?? hit;
    lastLocated = el;
    // A point inside an iframe resolves to the <iframe> here; its selectors
    // would point at the frame, not the control, so don't offer them.
    const usable = el && el.tagName !== 'IFRAME' && el.tagName !== 'FRAME';
    return {
      ok: true,
      x: action.x,
      y: action.y,
      ...(usable ? { healedSelectors: generateSelectors(el) } : {}),
    };
  }
  const el = lastCandidates[action.index];
  if (!el || !el.isConnected) return { ok: false, error: `element [${action.index}] is no longer on the page` };
  return pointAt(el, false, true);
};

// Compatible-mode agent action with page-level events.
export const agentAct = async (action: AgentAction): Promise<ExecResult> => {
  try {
    if (action.kind === 'scroll') {
      window.scrollBy({ top: action.dy, behavior: 'smooth' });
      await sleep(450);
      return { ok: true };
    }
    if (action.kind === 'clickAt') {
      const hit = deepElementFromPoint(action.x, action.y);
      if (!hit) return { ok: false, error: `nothing at (${action.x}, ${action.y})` };
      // Climb to the nearest conventional control; the raw hit is often a
      // text node's span inside the real clickable.
      const el = (hit.closest?.(INTERACTIVE_SELECTOR) as Element | null) ?? hit;
      await cursorMoveTo(action.x, action.y);
      cursorPulse(action.x, action.y);
      (el as HTMLElement).focus?.();
      dispatchClick(el, action.x, action.y);
      cursorHide();
      return { ok: true, healedSelectors: generateSelectors(el) };
    }
    const el = lastCandidates[action.index];
    if (!el || !el.isConnected) return { ok: false, error: `element [${action.index}] is no longer on the page` };
    const a = await waitActionable(el, false);
    if (!a.ok) return { ok: false, error: a.error };
    await cursorMoveTo(a.x, a.y);
    if (action.kind === 'click') {
      cursorPulse(a.x, a.y);
      (el as HTMLElement).focus?.();
      dispatchClick(el, a.x, a.y);
    } else if (action.kind === 'type') {
      await typeInto(el, action.text, false);
    } else {
      cursorPulse(a.x, a.y);
      (el as HTMLElement).focus?.();
      dispatchKey(el, action.key);
    }
    cursorHide();
    return { ok: true, healedSelectors: generateSelectors(el) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export const highlightTarget = async (target: TargetInfo): Promise<boolean> => {
  const el = await waitForTarget(target, 5_000);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  await sleep(350);
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  await cursorMoveTo(x, y);
  cursorPulse(x, y);
  const restore = highlightElement(el);
  (el as HTMLElement).focus?.();
  setTimeout(restore, 15_000);
  cursorHide();
  return true;
};
