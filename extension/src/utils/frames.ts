import { deepQueryAll } from './selectors';

// Where is this frame on the top-level page? CDP clicks take top-level
// viewport coordinates, but a content script inside an iframe only knows
// positions inside its own frame — and a cross-site parent can't be read.
// So each frame asks its parent over postMessage; the parent's content
// script finds the <iframe> element that owns the asking window, adds its
// position to its own offset (asking its parent in turn), and replies.

const REQ = 'leo:frameOffset?';
const RES = 'leo:frameOffset!';

export interface Point {
  x: number;
  y: number;
}

export const frameOffset = (timeoutMs = 2_000): Promise<Point> => {
  if (window.top === window) return Promise.resolve({ x: 0, y: 0 });
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return;
      const d = ev.data as Record<string, unknown> | null;
      if (!d || d[RES] !== id) return;
      cleanup();
      resolve({ x: Number(d.x) || 0, y: Number(d.y) || 0 });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('could not locate this frame on the page'));
    }, timeoutMs);
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ [REQ]: id }, '*');
  });
};

// Installed by the content script in every frame so child frames can ask.
export const installFrameOffsetResponder = (): void => {
  window.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || typeof d[REQ] !== 'string') return;
    const source = ev.source as Window | null;
    if (!source) return;
    const frame = deepQueryAll('iframe, frame').find(
      (f) => (f as HTMLIFrameElement).contentWindow === source,
    ) as HTMLIFrameElement | undefined;
    if (!frame) return;
    void (async () => {
      let own: Point;
      try {
        own = await frameOffset();
      } catch {
        return; // our own parent didn't answer; the child will time out
      }
      const r = frame.getBoundingClientRect();
      const cs = getComputedStyle(frame);
      source.postMessage(
        {
          [RES]: d[REQ],
          x: own.x + r.left + frame.clientLeft + (parseFloat(cs.paddingLeft) || 0),
          y: own.y + r.top + frame.clientTop + (parseFloat(cs.paddingTop) || 0),
        },
        '*',
      );
    })();
  });
};
