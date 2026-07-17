import { buildTarget, fieldLabel } from './selectors';
import type { Step } from './types';

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

const isTextEntry = (el: Element): boolean => {
  if ((el as HTMLElement).isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(type);
};

export const attachRecorder = (emit: EmitFn): (() => void) => {
  let pending: PendingType | null = null;
  let lastClickEl: Element | null = null;
  let lastClickAt = 0;

  const flush = () => {
    if (!pending) return;
    const step = pending.step;
    pending = null;
    // An empty non-secret type step means the user cleared a field; still
    // worth replaying. A totally untouched pending should not happen since
    // pendings are only created on input events.
    emit(step);
  };

  const onClick = (ev: MouseEvent) => {
    if (!ev.isTrusted) return;
    const raw = ev.target as Element | null;
    if (!raw || !(raw instanceof Element)) return;
    const el = (raw.closest?.(CLICKABLE) as Element | null) ?? raw;

    // Clicks on native <select> elements are noise: the popup cannot be
    // opened by a synthetic click at replay time, and the meaningful action
    // (the chosen option) arrives as a change event and becomes a `select`
    // step. Recording the click would just replay a no-op.
    const selTag = el.tagName.toLowerCase();
    if (selTag === 'select' || selTag === 'option') return;

    // Clicking the field being typed into is just refocusing; skip it.
    if (pending && (el === pending.el || raw === pending.el)) return;
    flush();

    emit({ type: 'click', target: buildTarget(el, 'click') });
    lastClickEl = el;
    lastClickAt = Date.now();
  };

  const onDblClick = (ev: MouseEvent) => {
    if (!ev.isTrusted) return;
    const raw = ev.target as Element | null;
    if (!raw || !(raw instanceof Element)) return;
    const el = (raw.closest?.(CLICKABLE) as Element | null) ?? raw;
    // The two clicks of the double-click were already recorded; replace them.
    const replace = el === lastClickEl && Date.now() - lastClickAt < 700 ? 2 : 0;
    emit({ type: 'dblclick', target: buildTarget(el, 'click') }, replace);
  };

  const onInput = (ev: Event) => {
    if (!ev.isTrusted) return;
    const el = ev.target as Element | null;
    if (!el || !(el instanceof Element) || !isTextEntry(el)) return;

    const input = el as HTMLInputElement;
    const secret = input.type === 'password';
    const value = (el as HTMLElement).isContentEditable
      ? ((el as HTMLElement).textContent ?? '')
      : (input.value ?? '');

    if (pending && pending.el !== el) flush();
    if (!pending) {
      pending = {
        el,
        step: {
          type: 'type',
          target: buildTarget(el, 'type'),
          text: '',
          secret,
        },
      };
      if (secret) {
        pending.step.target.intent = `Type the password into the "${fieldLabel(el)}" field`;
      }
    }
    // Passwords are never stored, not even transiently in the step object.
    pending.step.text = secret ? '' : value;
  };

  // Selects fire both `input` and `change` for one pick; some frameworks
  // swallow one of them, so listen to both and dedupe on element + value.
  let lastSelect: { el: Element; value: string } | null = null;
  const onSelectPick = (ev: Event) => {
    if (!ev.isTrusted) return;
    const el = ev.target as Element | null;
    if (!el || !(el instanceof Element)) return;
    if (el.tagName.toLowerCase() !== 'select') return;
    const select = el as HTMLSelectElement;
    if (lastSelect && lastSelect.el === el && lastSelect.value === select.value) return;
    lastSelect = { el, value: select.value };
    emit({
      type: 'select',
      target: buildTarget(el, 'select'),
      value: select.value,
      label: select.selectedOptions[0]?.label ?? select.value,
    });
  };
  const onChange = onSelectPick;

  const onKeyDown = (ev: KeyboardEvent) => {
    if (!ev.isTrusted) return;
    if (ev.key !== 'Enter' && ev.key !== 'Tab' && ev.key !== 'Escape') return;
    const active = document.activeElement;
    const inField = active ? isTextEntry(active) || active.tagName === 'SELECT' : false;
    // Tab/Escape outside a field is browser chrome noise, not workflow.
    if (ev.key !== 'Enter' && !inField) return;
    flush();
    emit({
      type: 'key',
      key: ev.key as 'Enter' | 'Tab' | 'Escape',
      target: active && inField ? buildTarget(active, 'click') : undefined,
    });
  };

  const onBlur = (ev: FocusEvent) => {
    if (pending && ev.target === pending.el) flush();
  };

  // The page is going away (navigation); get the pending type out now.
  const onPageHide = () => flush();

  window.addEventListener('click', onClick, true);
  window.addEventListener('dblclick', onDblClick, true);
  window.addEventListener('input', onInput, true);
  window.addEventListener('input', onSelectPick, true);
  window.addEventListener('change', onChange, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur, true);
  window.addEventListener('pagehide', onPageHide, true);

  return () => {
    flush();
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('dblclick', onDblClick, true);
    window.removeEventListener('input', onInput, true);
    window.removeEventListener('input', onSelectPick, true);
    window.removeEventListener('change', onChange, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onBlur, true);
    window.removeEventListener('pagehide', onPageHide, true);
  };
};
