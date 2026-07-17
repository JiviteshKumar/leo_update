import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from './App';

const POS_KEY = 'leo:floatPos';
const COLLAPSED_KEY = 'leo:floatCollapsed';
const OPEN_KEY = 'leo:uiOpen';

// Storage calls throw *synchronously* ("Extension context invalidated") once
// this content script is orphaned by a reload; swallow so a stale menu never
// raises an uncaught error before it's torn down.
const quietStorage = (fn: () => Promise<unknown>): void => {
  try {
    void fn().catch(() => {});
  } catch {
    // context already invalidated
  }
};

interface Pos {
  right: number;
  bottom: number;
}
const DEFAULT_POS: Pos = { right: 16, bottom: 16 };

// The floating menu: a draggable, collapsible card wrapping the shared App.
// Visibility is a single global flag in storage.local. This component reads it
// on mount and watches storage.onChanged, so the toolbar toggle (a one-line
// flag write in the background) shows/hides the menu on every tab at once —
// no messaging, no mount-timing races, works the same on any site.
export function FloatingApp() {
  const [visible, setVisibleState] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState<Pos>(DEFAULT_POS);
  const drag = useRef<{ startX: number; startY: number; base: Pos } | null>(null);
  const [dragging, setDragging] = useState(false);

  // The close button writes the shared flag so it hides everywhere.
  const setVisible = useCallback((v: boolean) => {
    setVisibleState(v);
    quietStorage(() => browser.storage.local.set({ [OPEN_KEY]: v }));
  }, []);

  // Restore persisted position + collapsed state and the current visibility.
  useEffect(() => {
    quietStorage(() =>
      browser.storage.local.get([POS_KEY, COLLAPSED_KEY, OPEN_KEY]).then((res) => {
        const p = res[POS_KEY] as Pos | undefined;
        if (p && typeof p.right === 'number' && typeof p.bottom === 'number') setPos(p);
        if (res[COLLAPSED_KEY]) setCollapsed(true);
        if (res[OPEN_KEY]) setVisibleState(true);
      }),
    );
  }, []);

  // React to the shared visibility flag flipping (toolbar toggle, run start,
  // or a close on another tab).
  useEffect(() => {
    const onChanged = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => {
      if (area === 'local' && OPEN_KEY in changes) {
        setVisibleState(Boolean(changes[OPEN_KEY].newValue));
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      try {
        browser.storage.onChanged.removeListener(onChanged);
      } catch {
        // context already invalidated
      }
    };
  }, []);

  const onDragMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // Dragging by the bar: moving right/down shrinks the right/bottom insets.
    setPos({
      right: Math.max(0, d.base.right - (e.clientX - d.startX)),
      bottom: Math.max(0, d.base.bottom - (e.clientY - d.startY)),
    });
  }, []);

  const onDragEnd = useCallback(() => {
    drag.current = null;
    setDragging(false);
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    setPos((p) => {
      quietStorage(() => browser.storage.local.set({ [POS_KEY]: p }));
      return p;
    });
  }, [onDragMove]);

  const onDragStart = (e: React.PointerEvent) => {
    // Ignore drags that start on the bar's buttons.
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { startX: e.clientX, startY: e.clientY, base: pos };
    setDragging(true);
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
  };

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      quietStorage(() => browser.storage.local.set({ [COLLAPSED_KEY]: !c }));
      return !c;
    });
  };

  return (
    <div
      className={`leo-root leo-float${visible ? '' : ' hidden'}${collapsed ? ' collapsed' : ''}`}
      style={{ right: `${pos.right}px`, bottom: `${pos.bottom}px` }}
    >
      <div
        className={`leo-float-bar${dragging ? ' dragging' : ''}`}
        onPointerDown={onDragStart}
      >
        <span className="leo-float-title">Leo</span>
        <button title={collapsed ? 'Expand' : 'Collapse'} onClick={toggleCollapsed}>
          {collapsed ? '▢' : '—'}
        </button>
        <button title="Close" onClick={() => setVisible(false)}>
          ✕
        </button>
      </div>
      <div className="leo-float-body">
        <App />
      </div>
    </div>
  );
}
