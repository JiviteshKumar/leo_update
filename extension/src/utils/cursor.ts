// Visible "ghost cursor" that glides to elements during replay so the user
// can watch Leo drive the page. Pure DOM overlay, pointer-events: none, so
// it never intercepts the synthetic events aimed at the page underneath.
//
// The pointer is a glowing triangle; its color comes from Leo settings and
// updates live via storage.onChanged. Everything renders with currentColor,
// so recoloring is a single style.color write.

import { DEFAULT_CURSOR_COLOR } from './types';

const CURSOR_ID = 'leo-ghost-cursor';

// Marks nodes Leo adds to the page (cursor, pulse rings, styles) so page
// observers in Leo — like "wait until the page is quiet" — can ignore them.
export const LEO_NODE_ATTR = 'data-leo';
const SETTINGS_KEY = 'leo:settings';

let color = DEFAULT_CURSOR_COLOR;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const applyColor = (): void => {
  const cursor = document.getElementById(CURSOR_ID);
  if (cursor) cursor.style.color = color;
};

void (async () => {
  try {
    const res = await browser.storage.local.get(SETTINGS_KEY);
    const stored = (res[SETTINGS_KEY] as { cursorColor?: string } | undefined)
      ?.cursorColor;
    if (stored) {
      color = stored;
      applyColor();
    }
  } catch {
    // storage unavailable; keep the default
  }
})();

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const next = (changes[SETTINGS_KEY].newValue as { cursorColor?: string } | undefined)
    ?.cursorColor;
  color = next || DEFAULT_CURSOR_COLOR;
  applyColor();
});

const ensure = (): HTMLElement => {
  let cursor = document.getElementById(CURSOR_ID);
  if (cursor) return cursor;
  cursor = document.createElement('div');
  cursor.id = CURSOR_ID;
  cursor.setAttribute(LEO_NODE_ATTR, '');
  cursor.style.cssText = [
    'position: fixed',
    'left: 0',
    'top: 0',
    'width: 28px',
    'height: 28px',
    `color: ${color}`,
    'z-index: 2147483647',
    'pointer-events: none',
    'transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease',
    'transform: translate(40vw, 40vh)',
    'opacity: 0',
    // Soft neon glow around the pointer, in the pointer's own color.
    'filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35)) ' +
      'drop-shadow(0 0 6px currentColor) drop-shadow(0 0 18px currentColor)',
  ].join(';');
  // Figma-style pointer triangle. currentColor fill; thin light stroke keeps
  // it visible when it crosses same-colored backgrounds.
  cursor.innerHTML =
    '<svg viewBox="0 0 28 28" width="28" height="28">' +
    '<path d="M4 2 L24.5 12.5 L14.5 15.2 L9.4 25 Z" fill="currentColor" ' +
    'stroke="rgba(255,255,255,0.85)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(cursor);
  return cursor;
};

export const cursorMoveTo = async (x: number, y: number): Promise<void> => {
  const cursor = ensure();
  if (hideTimer) clearTimeout(hideTimer);
  cursor.style.opacity = '1';
  cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  await new Promise((r) => setTimeout(r, 480));
};

export const cursorPulse = (x: number, y: number): void => {
  const ring = document.createElement('div');
  ring.setAttribute(LEO_NODE_ATTR, '');
  ring.style.cssText = [
    'position: fixed',
    `left: ${Math.round(x - 20)}px`,
    `top: ${Math.round(y - 20)}px`,
    'width: 40px',
    'height: 40px',
    `color: ${color}`,
    'border: 3px solid currentColor',
    'border-radius: 50%',
    'box-shadow: 0 0 14px currentColor, inset 0 0 8px currentColor',
    'z-index: 2147483646',
    'pointer-events: none',
    'animation: leo-pulse 0.55s ease-out forwards',
  ].join(';');
  injectKeyframes();
  document.documentElement.appendChild(ring);
  setTimeout(() => ring.remove(), 650);
};

export const cursorHide = (): void => {
  const cursor = document.getElementById(CURSOR_ID);
  if (!cursor) return;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    cursor.style.opacity = '0';
  }, 800);
};

export const highlightElement = (el: Element): (() => void) => {
  const html = el as HTMLElement;
  const prevOutline = html.style.outline;
  const prevOffset = html.style.outlineOffset;
  const prevShadow = html.style.boxShadow;
  html.style.outline = `3px solid ${color}`;
  html.style.outlineOffset = '2px';
  html.style.boxShadow = `0 0 16px ${color}`;
  return () => {
    html.style.outline = prevOutline;
    html.style.outlineOffset = prevOffset;
    html.style.boxShadow = prevShadow;
  };
};

let keyframesInjected = false;
const injectKeyframes = (): void => {
  if (keyframesInjected) return;
  keyframesInjected = true;
  const style = document.createElement('style');
  style.setAttribute(LEO_NODE_ATTR, '');
  style.textContent =
    '@keyframes leo-pulse { from { transform: scale(0.45); opacity: 1; } to { transform: scale(1.7); opacity: 0; } }';
  document.documentElement.appendChild(style);
};
