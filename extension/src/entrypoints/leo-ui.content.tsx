import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { createRoot, type Root } from 'react-dom/client';
import { FloatingApp } from '@/ui/FloatingApp';
import { LEO_UI_HOST } from '@/utils/types';
import type { BgToContentMessage } from '@/utils/types';
import '@/ui/styles.css';

// Leo's floating menu, injected into the top frame of every page inside a
// shadow root (CSS isolation; events retarget to the <leo-ui> host so the
// recorder ignores them). FloatingApp owns its own visibility by watching the
// `leo:uiOpen` flag in storage.local, so this entrypoint just mounts it.
export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    if (window.top !== window) return; // top frame only
    // The background may inject this script on demand (tabs open before the
    // extension loaded); bail if a host is already present to avoid two menus.
    if (document.querySelector(LEO_UI_HOST)) return;

    // Answer the background's presence check so it doesn't re-inject a menu
    // that already exists. Registered up front, before the async mount.
    browser.runtime.onMessage.addListener(
      (msg: BgToContentMessage, _sender, sendResponse) => {
        if (msg.kind === 'ui.ping') {
          sendResponse({ ok: true });
          return true;
        }
        return false;
      },
    );

    const ui = await createShadowRootUi<Root>(ctx, {
      name: LEO_UI_HOST,
      // The card positions itself with `position: fixed`; the host just needs
      // to exist in the DOM, so an inline anchor at <body> is enough.
      position: 'inline',
      mode: 'open',
      // Stop Leo's own key/input/click events from reaching the page's
      // listeners. (The recorder uses capture-phase window listeners and is
      // guarded separately via isLeoEvent.)
      isolateEvents: ['keydown', 'keyup', 'input', 'change', 'click'],
      onMount(container) {
        const root = createRoot(container);
        root.render(<FloatingApp />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });

    ui.mount();

    // On extension reload this script is orphaned; unmount the stale menu so
    // its polling loop stops hitting the dead runtime.
    ctx.onInvalidated(() => ui.remove());
  },
});
