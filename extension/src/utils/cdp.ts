import type { KeyMods } from './types';

// Trusted input through the Chrome DevTools Protocol (chrome.debugger).
//
// Events a content script dispatches are `isTrusted: false`; many sites
// ignore them (anti-bot checks, some framework handlers), and the browser
// won't run default actions for them (native form submit on Enter, focus
// changes on Tab, opening a <select>). CDP input goes through the browser's
// real input pipeline, exactly like a user's mouse and keyboard, and it also
// routes clicks into cross-site iframes by hit-testing.
//
// Attaching shows Chrome's "Leo started debugging this browser" bar while a
// run is active. If attaching fails, or the user dismisses the bar, callers
// fall back to content-script events.

const PROTOCOL = '1.3';

// Modifier bitmask used by Input.dispatch*Event.
const modBits = (m: KeyMods = {}): number =>
  (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);

interface KeyDef {
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
};

export const keyDefinition = (key: string): KeyDef => {
  const named = NAMED_KEYS[key];
  if (named) return named;
  const fn = /^F(\d{1,2})$/.exec(key);
  if (fn) return { code: key, keyCode: 111 + Number(fn[1]) };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (/[A-Z]/.test(upper)) return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
    if (/[0-9]/.test(key)) return { code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
    return { code: '', keyCode: 0, text: key };
  }
  return { code: key, keyCode: 0 };
};

export class CdpTab {
  private attached = false;
  // Set when Chrome detaches us (user cancelled the debugging bar, tab
  // crashed or closed). Callers then fall back to content-script input.
  lostReason: string | null = null;

  constructor(readonly tabId: number) {}

  get isAttached(): boolean {
    return this.attached;
  }

  async attach(): Promise<boolean> {
    if (this.attached) return true;
    try {
      await browser.debugger.attach({ tabId: this.tabId }, PROTOCOL);
    } catch (err) {
      this.lostReason = err instanceof Error ? err.message : String(err);
      return false;
    }
    this.attached = true;
    this.lostReason = null;
    return true;
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    this.attached = false;
    await browser.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }

  // Called from the global onDetach listener.
  markDetached(reason: string): void {
    this.attached = false;
    this.lostReason = reason;
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return browser.debugger.sendCommand({ tabId: this.tabId }, method, params) as Promise<T>;
  }

  async click(x: number, y: number, clickCount = 1): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    for (let n = 1; n <= clickCount; n++) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: n,
      });
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: n,
      });
    }
  }

  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }

  // Types into the focused element. insertText is IME-style input: any
  // Unicode (CJK, emoji) works and the page sees normal input events.
  async insertText(text: string, perCharDelayMs = 0): Promise<void> {
    if (!perCharDelayMs) {
      await this.send('Input.insertText', { text });
      return;
    }
    for (const ch of text) {
      await this.send('Input.insertText', { text: ch });
      await new Promise((r) => setTimeout(r, perCharDelayMs));
    }
  }

  async key(key: string, mods: KeyMods = {}): Promise<void> {
    const def = keyDefinition(key);
    const modifiers = modBits(mods);
    // Shortcuts (Ctrl/Cmd/Alt + key) carry no text, like the real keyboard.
    const text = mods.ctrl || mods.meta || mods.alt ? undefined : def.text;
    const base = {
      key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      modifiers,
    };
    await this.send('Input.dispatchKeyEvent', {
      ...base,
      type: text ? 'keyDown' : 'rawKeyDown',
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  // JPEG of the tab's viewport, base64, at device pixels. Works even when the
  // tab isn't the visible one (unlike tabs.captureVisibleTab).
  async screenshot(timeoutMs = 5_000): Promise<string | null> {
    const shot = this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 70,
    }).then((r) => r.data);
    return Promise.race([
      shot.catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
  }
}
