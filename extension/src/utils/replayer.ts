import { cursorHide, cursorMoveTo, cursorPulse, highlightElement } from './cursor';
import { generateSelectors, isVisible, trySelector, visibleText } from './selectors';
import type {
  AgentAction,
  AgentSnapshot,
  Candidate,
  ElementStep,
  ExecResult,
  KeyMods,
  KeyStep,
  Step,
  TargetInfo,
} from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const FIND_TIMEOUT_MS = 8_000;

const waitFor = async (
  selectors: string[],
  timeoutMs = FIND_TIMEOUT_MS,
): Promise<Element | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (document.readyState !== 'loading') {
      const el = trySelector(selectors);
      if (el) return el;
    }
    await sleep(250);
  }
  return null;
};

// React/Vue controlled inputs ignore direct .value writes; going through the
// prototype setter + input event is the reliable path (same trick as
// clarity's steps/helpers.ts).
const setNativeValue = (
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void => {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const center = (el: Element): { x: number; y: number } => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
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

// In fast (agent) mode: no smooth scroll, no cursor glide, no settle delays.
// The pulse ring still fires from performOn so the action stays visible.
const glideToElement = async (
  el: Element,
  fast: boolean,
): Promise<{ x: number; y: number }> => {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: fast ? 'auto' : 'smooth' });
  if (!fast) await sleep(350);
  const { x, y } = center(el);
  if (!fast) await cursorMoveTo(x, y);
  return { x, y };
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
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }),
    );
    setNativeValue(input, current);
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await sleep(text.length > 40 ? 8 : 35);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  ' ': 32,
};

const dispatchKey = (el: Element, key: string, mods: KeyMods = {}): void => {
  const keyCode =
    KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
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
  if (key === 'Enter' && !mods.ctrl && !mods.meta && !mods.alt && !handled && form) {
    form.requestSubmit();
  }
};

// ---------------------------------------------------------------------------
// Candidate collection for AI healing
// ---------------------------------------------------------------------------

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"], ' +
  '[role="tab"], [role="menuitem"], [role="option"], [onclick], [contenteditable="true"]';

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
    const c: Candidate = {
      index,
      tag: el.tagName.toLowerCase(),
      text: visibleText(el).slice(0, 80),
      attrs,
    };
    if (withRects) {
      const r = el.getBoundingClientRect();
      c.rect = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }
    return c;
  });
};

export const collectCandidates = (): Candidate[] =>
  describe(Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(isVisible).slice(0, 120));

// Broader than INTERACTIVE_SELECTOR: the agent must see attribute-poor
// controls too — calendar arrows (bare <svg> with cursor:pointer), custom
// widgets, icon buttons. Anything with a click affordance is fair game.
const AGENT_SELECTOR =
  INTERACTIVE_SELECTOR + ', svg, [role], [tabindex], [aria-label]';

const hasClickAffordance = (el: Element): boolean => {
  if (el.matches(INTERACTIVE_SELECTOR)) return true;
  if (el.getAttribute('role') || el.getAttribute('aria-label')) return true;
  const ti = el.getAttribute('tabindex');
  if (ti && ti !== '-1') return true;
  // cursor:pointer on the element or its immediate parent is the usual tell
  // for a React-handled clickable that carries no DOM attribute.
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
  const els = Array.from(document.querySelectorAll(AGENT_SELECTOR))
    .filter((el) => isVisible(el) && hasClickAffordance(el))
    .slice(0, 150);
  return {
    candidates: describe(els, true),
    pageText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 3000),
    title: document.title,
    url: location.href,
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
  };
};

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

const performOn = async (el: Element, step: Step, fast: boolean): Promise<void> => {
  const { x, y } = await glideToElement(el, fast);
  switch (step.type) {
    case 'click': {
      cursorPulse(x, y);
      (el as HTMLElement).focus?.();
      dispatchClick(el, x, y);
      break;
    }
    case 'dblclick': {
      cursorPulse(x, y);
      dispatchClick(el, x, y);
      dispatchClick(el, x, y);
      el.dispatchEvent(new MouseEvent('dblclick', mouseEventInit(x, y)));
      break;
    }
    case 'type': {
      await typeInto(el, step.text, fast);
      break;
    }
    case 'select': {
      cursorPulse(x, y);
      const select = el as HTMLSelectElement;
      const byValue = Array.from(select.options).some((o) => o.value === step.value);
      if (byValue) setNativeValue(select, step.value);
      else {
        const opt = Array.from(select.options).find((o) => o.label === step.label);
        if (opt) setNativeValue(select, opt.value);
        else throw new Error(`option not found: ${step.label}`);
      }
      select.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    case 'key': {
      cursorPulse(x, y);
      (el as HTMLElement).focus?.();
      dispatchKey(el, step.key, step.mods);
      break;
    }
    default:
      throw new Error(`unsupported step: ${(step as Step).type}`);
  }
  cursorHide();
};

export const execStep = async (
  step: ElementStep | KeyStep,
  fast = false,
): Promise<ExecResult> => {
  try {
    if (step.type === 'key' && !step.target) {
      const el = document.activeElement ?? document.body;
      dispatchKey(el, step.key, step.mods);
      return { ok: true };
    }
    const target = step.target!;
    const el = await waitFor(target.selectors);
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
export const execCandidate = async (
  index: number,
  step: ElementStep,
  fast = false,
): Promise<ExecResult> => {
  try {
    const el = lastCandidates[index];
    if (!el || !el.isConnected) {
      return { ok: false, error: 'healed element disappeared before execution' };
    }
    await performOn(el, step, fast);
    return { ok: true, healedSelectors: generateSelectors(el) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// Execute one agent action. Index actions target a candidate from the last
// agentSnapshot() sweep; clickAt targets a screenshot coordinate (elements
// the sweep missed). Reuses the same visible click/type machinery as replay.
export const agentAct = async (action: AgentAction): Promise<ExecResult> => {
  try {
    if (action.kind === 'scroll') {
      window.scrollBy({ top: action.dy, behavior: 'smooth' });
      await sleep(450);
      return { ok: true };
    }
    if (action.kind === 'clickAt') {
      const hit = document.elementFromPoint(action.x, action.y);
      if (!hit) {
        return { ok: false, error: `nothing at (${action.x}, ${action.y})` };
      }
      // Climb to the nearest conventional control; the raw hit is often a
      // text node's span inside the real clickable.
      const el = (hit.closest?.(INTERACTIVE_SELECTOR) as Element | null) ?? hit;
      const { x, y } = await glideToElement(el, false);
      cursorPulse(x, y);
      (el as HTMLElement).focus?.();
      dispatchClick(el, x, y);
      cursorHide();
      // Fresh selectors let the background repair the saved workflow when
      // this action turns out to be the recovery of a recorded step.
      return { ok: true, healedSelectors: generateSelectors(el) };
    }

    const el = lastCandidates[action.index];
    if (!el || !el.isConnected) {
      return { ok: false, error: `element [${action.index}] is no longer on the page` };
    }
    const { x, y } = await glideToElement(el, false);
    if (action.kind === 'click') {
      cursorPulse(x, y);
      (el as HTMLElement).focus?.();
      dispatchClick(el, x, y);
    } else if (action.kind === 'type') {
      await typeInto(el, action.text, false);
    } else {
      cursorPulse(x, y);
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
  const el = await waitFor(target.selectors, 5_000);
  if (!el) return false;
  const { x, y } = await glideToElement(el, false);
  cursorPulse(x, y);
  const restore = highlightElement(el);
  (el as HTMLElement).focus?.();
  setTimeout(restore, 15_000);
  cursorHide();
  return true;
};
