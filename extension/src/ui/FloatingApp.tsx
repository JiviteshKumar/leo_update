import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from './App';

const POS_KEY = 'leo:floatPos';
const COLLAPSED_KEY = 'leo:floatCollapsed';
const OPEN_KEY = 'leo:uiOpen';

interface Pos {
  right: number;
  bottom: number;
}
const DEFAULT_POS: Pos = { right: 16, bottom: 16 };

// The floating menu: a draggable, collapsible card wrapping the shared App.
// The content script drives visibility via `registerSetVisible`; this
// component is the sole writer of the `leo:uiOpen` session flag, so the menu
// re-appears (or stays hidden) across navigations to match its last state.
export function FloatingApp({
  registerSetVisible,
}: {
  registerSetVisible: (fn: (visible: boolean) => void) => void;
}) {
  const [visible, setVisibleState] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState<Pos>(DEFAULT_POS);
  const drag = useRef<{ startX: number; startY: number; base: Pos } | null>(null);
  const [dragging, setDragging] = useState(false);

  const setVisible = useCallback((v: boolean) => {
    setVisibleState(v);
    void browser.storage.session.set({ [OPEN_KEY]: v }).catch(() => {});
  }, []);

  // Restore persisted position + collapsed state, and last visibility (the
  // session flag survives navigations so the menu stays open across them).
  useEffect(() => {
    void browser.storage.local.get([POS_KEY, COLLAPSED_KEY]).then((res) => {
      const p = res[POS_KEY] as Pos | undefined;
      if (p && typeof p.right === 'number' && typeof p.bottom === 'number') setPos(p);
      if (res[COLLAPSED_KEY]) setCollapsed(true);
    });
    void browser.storage.session
      .get(OPEN_KEY)
      .then((res) => {
        if (res[OPEN_KEY]) setVisibleState(true);
      })
      .catch(() => {});
  }, []);

  // Let the content script push visibility (toolbar toggle, run start, …).
  useEffect(() => {
    registerSetVisible((v) => setVisibleState(v));
  }, [registerSetVisible]);

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
      void browser.storage.local.set({ [POS_KEY]: p });
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
      void browser.storage.local.set({ [COLLAPSED_KEY]: !c });
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
        <App surface="float" />
      </div>
    </div>
  );
}
