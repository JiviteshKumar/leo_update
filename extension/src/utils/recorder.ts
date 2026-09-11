import { buildTarget, composedContains, fieldLabel } from './selectors';
import { LEO_UI_HOST } from './types';
import type { KeyMods, RelPoint, Step } from './types';

// DOM event capture for recording. Attached in the capture phase on window
// so the page can't stop events from reaching us. Only trusted (real user)
// events are recorded, which also makes replay-driven synthetic events
// invisible to the recorder for free.

type EmitFn = (step: Step, replaceLastClicks?: number) => void;

interface PendingType {
  el: Element;
  step: Extract<Step, { type: 'type' }>;
}

const CLICKABLE =
  'a, button, input, select, textarea, label, [role="button"], [role="link"], ' +
  '[role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [onclick]';

// The element the user actually interacted with. Events from inside an open
// shadow root are retargeted to its host by the time they reach `window`;
// composedPath()[0] is the real target.
const realTarget = (ev: Event): Element | null => {
  const first = ev.composedPath?.()[0];
  if (first instanceof Element) return first;
  return ev.target instanceof Element ? ev.target : null;
};

// True when an event came from Leo's own floating menu.
const isLeoEvent = (ev: Event): boolean => {
  const isHost = (n: EventTarget | null): boolean =>
    n instanceof Element && n.tagName.toLowerCase() === LEO_UI_HOST;
  if (isHost(ev.target)) return true;
  const path = ev.composedPath?.();
  return path ? path.some(isHost) : false;
};

const isTextEntry = (el: Element): boolean => {
  if ((el as HTMLElement).isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(type);
};

const isFileInput = (el: Element): boolean =>
  el.tagName.toLowerCase() === 'input' && (el as HTMLInputElement).type === 'file';

// Elements whose drags are gestures worth recording (a list item, a card,
// a slider), as opposed to selecting text.
const DRAGGABLE =
  '[draggable="true"], li, tr, [role="option"], [role="listitem"], [role="row"], [role="slider"], ' +
  'input[type="range"], [class*="drag"], [class*="sortable"], [class*="handle"], [class*="card"]';

const DRAG_THRESHOLD_PX = 12;

const relPos = (el: Element, x: number, y: number): RelPoint => {
  const r = el.getBoundingClientRect();
  const clamp = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  return {
    x: r.width ? clamp((x - r.left) / r.width) : 0.5,
    y: r.height ? clamp((y - r.top) / r.height) : 0.5,
  };
};

// The element under a point that isn't the thing being dragged (which
// often follows the pointer) or Leo's own UI.
const dropTargetAt = (x: number, y: number, dragged: Element): Element | null => {
  for (const el of document.elementsFromPoint(x, y)) {
    if (composedContains(dragged, el) || el.tagName.toLowerCase() === LEO_UI_HOST) continue;
    if (el === document.documentElement) continue;
    return el;
  }
  return null;
};

// For contenteditable, the editing host (the element with contenteditable),
// not whichever inner <p>/<span> the caret sits in.
const editingHost = (el: Element): Element => {
  if (!(el as HTMLElement).isContentEditable) return el;
  let host: Element = el;
  while (host.parentElement && (host.parentElement as HTMLElement).isContentEditable) {
    host = host.parentElement;
  }
  return host;
};

export const attachRecorder = (emit: EmitFn): (() => void) => {
  let pending: PendingType | null = null;
  let lastClickEl: Element | null = null;
  let lastClickAt = 0;
  // When the last recorded Enter key happened. Enter in a form makes the
  // browser click its submit button, and Enter on a button activates it;
  // either way it fires a click with no mouse behind it (detail === 0) that
  // is a consequence of the key step, not an action of its own.
  let lastEnterAt = 0;
  // Drag tracking. A finished drag also fires a click (press and release
  // on the same moved element); that click is part of the drag.
  let down: { el: Element; x: number; y: number } | null = null;
  let html5From: { el: Element; pos: RelPoint } | null = null;
  // The click a finished drag fires lands on the dragged element (or an
  // ancestor both ends share); only that click is swallowed.
  let dragClick: { el: Element; until: number } | null = null;

  const flush = () => {
    if (!pending) return;
    const step = pending.step;
    pending = null;
    emit(step);
  };

  const onClick = (ev: MouseEvent) => {
    if (!ev.isTrusted || isLeoEvent(ev)) return;
    // A keyboard-generated click right after a recorded Enter: replaying
    // the Enter reproduces it, so recording it too would act twice.
    if (ev.detail === 0 && Date.now() - lastEnterAt < 1_000) return;
    const raw = realTarget(ev);
    if (dragClick && Date.now() < dragClick.until && raw && (composedContains(dragClick.el, raw) || composedContains(raw, dragClick.el))) {
      dragClick = null;
      return;
    }
    if (!raw) return;
    const el = (raw.closest?.(CLICKABLE) as Element | null) ?? raw;

    // Clicks on native <select> elements are noise: the meaningful action
    // (the chosen option) arrives as a change event and becomes a `select`
    // step.
    const tag = el.tagName.toLowerCase();
    if (tag === 'select' || tag === 'option') return;
    // A file input's click only opens the OS file chooser; the chosen file
    // arrives as a change event and becomes an `upload` step.
    if (isFileInput(el)) return;

    // Clicking a <label> makes the browser click its control too. That
    // second click is a consequence, not a user action: replaying both
    // would toggle a checkbox twice.
    if (
      lastClickEl instanceof HTMLLabelElement &&
      lastClickEl.control === el &&
      Date.now() - lastClickAt < 500
    ) {
      return;
    }

    // Clicking the field being typed into is just refocusing; skip it.
    const host = editingHost(el);
    if (pending && (host === pending.el || raw === pending.el)) return;
    flush();

    emit({ type: 'click', target: buildTarget(el, 'click') });
    lastClickEl = el;
    lastClickAt = Date.now();
  };

  const onDblClick = (ev: MouseEvent) => {
    if (!ev.isTrusted || isLeoEvent(ev)) return;
    const raw = realTarget(ev);
    if (!raw) return;
    const el = (raw.closest?.(CLICKABLE) as Element | null) ?? raw;
    // The two clicks of the double-click were already recorded; replace them.
    const replace = el === lastClickEl && Date.now() - lastClickAt < 700 ? 2 : 0;
    emit({ type: 'dblclick', target: buildTarget(el, 'click') }, replace);
  };

  const captureValue = (ev: Event) => {
    if (!ev.isTrusted || isLeoEvent(ev)) return;
    const raw = realTarget(ev);
    if (!raw || !isTextEntry(raw)) return;
    const el = editingHost(raw);

    const input = el as HTMLInputElement;
    const secret = input.type === 'password';
    const value = (el as HTMLElement).isContentEditable ? (el.textContent ?? '') : (input.value ?? '');

    if (pending && pending.el !== el) flush();
    if (!pending) {
      pending = {
        el,
        step: { type: 'type', target: buildTarget(el, 'type'), text: '', secret },
      };
      if (secret) {
        pending.step.target.intent = `Type the password into the "${fieldLabel(el)}" field`;
      }
    }
    // Passwords are never stored, not even transiently in the step object.
    // During IME composition (CJK input) the value holds the in-progress
    // text; compositionend delivers the committed value.
    pending.step.text = secret ? '' : value;
  };

  // Selects fire both `input` and `change` for one pick; some frameworks
  // swallow one of them, so listen to both and dedupe on element + value.
  let lastSelect: { el: Element; value: string } | null = null;
  const onSelectPick = (ev: Event) => {
    if (!ev.isTrusted || isLeoEvent(ev)) return;
    const el = realTarget(ev);
    if (!el || el.tagName.toLowerCase() !== 'select') return;
    const select = el as HTMLSelectElement;
    if (lastSelect && lastSelect.el === el && lastSelect.value === select.value) return;
    lastSelect = { el, value: select.value };
    flush();
    emit({
      type: 'select',
      target: buildTarget(el, 'select'),
      value: select.value,
      label: select.selectedOptions[0]?.label ?? select.value,
    });
  };

  const onChange = (ev: Event) => {
    if (!ev.isTrusted || isLeoEvent(ev)) return;
    const el = realTarget(ev);
    if (el && isFileInput(el)) {
      if (!(el as HTMLInputElement).files?.length) return; // chooser cancelled
      flush();
      emit({ type: 'upload', target: buildTarget(el, 'upload') });
      return;
    }
    onSelectPick(ev);
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (!ev.isTrusted || isLeoEvent(ev)) return;
    // A modifier held on its own carries no action; keys during IME
    // composition belong to the composition.
    if (ev.key === 'Control' || ev.key === 'Meta' || ev.key === 'Alt' || ev.key === 'Shift') return;
    if (ev.isComposing || ev.key === 'Process') return;

    const cmdMod = ev.ctrlKey || ev.metaKey || ev.altKey;
    const active = realTarget(ev) ?? document.activeElement;
    const inField = active ? isTextEntry(active) || active.tagName === 'SELECT' : false;
    const onControl = Boolean(active?.closest?.(CLICKABLE));

    let record = false;
    if (ev.key === 'Enter' || ev.key === 'Tab' || ev.key === 'Escape') {
      // Tab/Escape outside a field is browser chrome noise, not workflow.
      record = ev.key === 'Enter' || inField;
    } else if (cmdMod) {
      // Clipboard/undo/select-all combos inside a text field are already
      // reflected in the captured field value, so skip them.
      const editCombo =
        inField && !ev.altKey && ['a', 'c', 'v', 'x', 'z', 'y'].includes(ev.key.toLowerCase());
      record = !editCombo;
    } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      // Arrow navigation matters for comboboxes/autocompletes/menus; a plain
      // arrow outside any control is just caret movement. On a native
      // <select> the resulting choice is recorded as a `select` step, so the
      // arrows themselves are noise.
      record = active?.tagName !== 'SELECT' && (inField || onControl);
    }
    if (!record) return;

    flush();
    if (ev.key === 'Enter') lastEnterAt = Date.now();
    const mods: KeyMods = {};
    if (ev.ctrlKey) mods.ctrl = true;
    if (ev.metaKey) mods.meta = true;
    if (ev.altKey) mods.alt = true;
    if (ev.shiftKey) mods.shift = true;
    const targetEl = active ? editingHost(active) : null;
    emit({
      type: 'key',
      key: ev.key,
      ...(Object.keys(mods).length ? { mods } : {}),
      target: targetEl && (inField || onControl) ? buildTarget(targetEl, 'click') : undefined,
    });
  };

  const emitDrag = (from: Element, to: Element, fromPos: RelPoint, toPos: RelPoint) => {
    flush();
    emit({ type: 'drag', from: buildTarget(from, 'drag'), to: buildTarget(to, 'drop'), fromPos, toPos });
    dragClick = { el: from, until: Date.now() + 500 };
  };

  const onPointerDown = (ev: PointerEvent) => {
    if (!ev.isTrusted || isLeoEvent(ev) || ev.button !== 0) return;
    const raw = realTarget(ev);
    down = raw ? { el: raw, x: ev.clientX, y: ev.clientY } : null;
  };

  // HTML5 drag-and-drop: dragstart … drop. (The browser swallows pointerup
  // during a native drag, so these events carry the gesture.)
  const onDragStart = (ev: DragEvent) => {
    if (!ev.isTrusted || isLeoEvent(ev)) return;
    const raw = realTarget(ev);
    if (!raw) return;
    const el = (raw.closest?.('[draggable="true"]') as Element | null) ?? raw;
    const start = down && composedContains(el, down.el) ? down : null;
    html5From = { el, pos: start ? relPos(el, start.x, start.y) : { x: 0.5, y: 0.5 } };
  };

  const onDrop = (ev: DragEvent) => {
    if (!ev.isTrusted || isLeoEvent(ev) || !html5From) return;
    const from = html5From;
    html5From = null;
    down = null;
    const to = dropTargetAt(ev.clientX, ev.clientY, from.el) ?? realTarget(ev);
    if (!to) return;
    emitDrag(from.el, to, from.pos, relPos(to, ev.clientX, ev.clientY));
  };

  const onDragEnd = () => {
    html5From = null;
  };

  // Pointer drags: press, move past a threshold, release.
  const onPointerUp = (ev: PointerEvent) => {
    if (!ev.isTrusted || !down || html5From) return;
    const start = down;
    down = null;
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD_PX) return;
    if (isTextEntry(start.el)) return; // selecting text in a field
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return; // selecting page text
    const from = (start.el.closest?.(DRAGGABLE) as Element | null) ?? null;
    if (!from) return;
    // A slider's drag starts and ends on the slider itself.
    const isSlider = from.matches('input[type="range"], [role="slider"]');
    const to = isSlider ? from : (dropTargetAt(ev.clientX, ev.clientY, from) ?? from);
    emitDrag(from, to, relPos(from, start.x, start.y), relPos(to, ev.clientX, ev.clientY));
  };

  const onBlur = (ev: FocusEvent) => {
    if (isLeoEvent(ev)) return;
    const el = realTarget(ev);
    if (pending && el && editingHost(el) === pending.el) flush();
  };

  // The page is going away (navigation); get the pending type out now.
  const onPageHide = () => flush();

  const listeners: [string, EventListener][] = [
    ['click', onClick as EventListener],
    ['dblclick', onDblClick as EventListener],
    ['input', captureValue],
    ['compositionend', captureValue],
    ['input', onSelectPick],
    ['change', onChange],
    ['keydown', onKeyDown as EventListener],
    ['blur', onBlur as EventListener],
    ['pointerdown', onPointerDown as EventListener],
    ['pointerup', onPointerUp as EventListener],
    ['dragstart', onDragStart as EventListener],
    ['drop', onDrop as EventListener],
    ['dragend', onDragEnd],
    ['pagehide', onPageHide],
  ];
  for (const [type, fn] of listeners) window.addEventListener(type, fn, true);

  return () => {
    flush();
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
  };
};
