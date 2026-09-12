import { cursorHide } from '@/utils/cursor';
import { installFrameOffsetResponder } from '@/utils/frames';
import { attachRecorder } from '@/utils/recorder';
import {
  agentAct,
  agentLocate,
  agentSnapshot,
  execCandidate,
  execDrag,
  execStep,
  focusLocated,
  hideLeoUiAt,
  highlightTarget,
  locate,
  locateCandidate,
  pageMark,
  selectAllLocated,
  setLocatedValue,
  settle,
  verifyLocated,
} from '@/utils/replayer';
import { matchesFrame } from '@/utils/selectors';
import type { BgToContentMessage, Step } from '@/utils/types';

// Runs on every page and frame. Two jobs:
//  - Recording: attach DOM listeners when the background says this tab is
//    being recorded (re-attaches automatically after each navigation).
//  - Replay: locate/act on elements the background asks about, in the frame
//    whose URL matches the step's framePath.

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    const isTop = window.top === window;
    let detach: (() => void) | null = null;

    // Lets child frames learn where they sit on the page (native clicks).
    installFrameOffsetResponder();

    const startRecording = () => {
      if (detach) return;
      detach = attachRecorder((step: Step, replaceLastClicks?: number) => {
        // After an extension reload this script is orphaned and sendMessage
        // throws synchronously; guard so a stray user event can't surface an
        // uncaught "Extension context invalidated".
        try {
          if (!browser.runtime?.id) return;
          void browser.runtime.sendMessage({ kind: 'rec.step', step, replaceLastClicks }).catch(() => {
            // background gone or recording stopped mid-flight
          });
        } catch {
          // context invalidated
        }
      });
    };

    const stopRecording = () => {
      detach?.();
      detach = null;
    };

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const askRecording = async (): Promise<boolean> => {
      try {
        const res = (await browser.runtime.sendMessage({ kind: 'rec.isRecording' })) as
          | { recording: boolean }
          | undefined;
        return res?.recording === true;
      } catch {
        return false; // extension context not ready
      }
    };

    // Ask whether this tab is mid-recording (survives navigations). Asked
    // again as the page loads: a tab the recorded page just opened can reach
    // document_start before the recording has switched over to it.
    const checkRecording = async () => {
      if (detach) return;
      if (await askRecording()) startRecording();
    };
    void checkRecording();
    document.addEventListener('DOMContentLoaded', () => void checkRecording(), { once: true });
    window.addEventListener('load', () => void checkRecording(), { once: true });

    // A tab another page opened — a sign-in popup, a target=_blank link — is
    // usually typed into immediately, well before the background has moved
    // the recording across. Listen from the first event and ask afterwards;
    // the background discards steps from tabs that aren't being recorded, so
    // listening too eagerly costs nothing and listening too late loses what
    // the user did.
    if (isTop && window.opener) {
      startRecording();
      void (async () => {
        for (const wait of [0, 150, 400, 1_000]) {
          if (wait) await sleep(wait);
          if (await askRecording()) return;
        }
        stopRecording();
      })();
    }

    // Reply asynchronously with the promise's result.
    const reply = <T>(p: Promise<T> | T, sendResponse: (r: T) => void): true => {
      void Promise.resolve(p).then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } as T),
      );
      return true;
    };

    browser.runtime.onMessage.addListener((msg: BgToContentMessage, _sender, sendResponse) => {
      switch (msg.kind) {
        case 'rec.attach':
          startRecording();
          sendResponse({ ok: true });
          return false;
        case 'rec.detach':
          stopRecording();
          sendResponse({ ok: true });
          return false;

        // Top frame only: one answer per tab.
        case 'replay.ping':
          if (!isTop) return false;
          sendResponse({ ok: true });
          return false;
        case 'replay.cursorHide':
          cursorHide();
          return false;
        case 'replay.settle':
          if (!isTop) return false;
          return reply(settle(msg.quietMs, msg.maxMs), sendResponse);
        case 'ui.clearPoint':
          if (!isTop) return false;
          sendResponse({ ok: true, hidden: hideLeoUiAt(msg.x, msg.y) });
          return false;
        case 'agent.snapshot':
          if (!isTop) return false;
          sendResponse(agentSnapshot());
          return false;
        case 'agent.locate':
          if (!isTop) return false;
          return reply(agentLocate(msg.action), sendResponse);
        case 'agent.act':
          if (!isTop) return false;
          return reply(agentAct(msg.action), sendResponse);

        // Frame-targeted: only the frame the element lives in answers.
        case 'replay.locate':
          if (!matchesFrame(msg.target.framePath)) return false;
          return reply(
            locate(msg.target, msg.fast === true, msg.timeoutMs, msg.pos, msg.hover !== false),
            sendResponse,
          );
        case 'replay.drag':
          if (!matchesFrame(msg.step.from.framePath)) return false;
          return reply(execDrag(msg.step, msg.fast === true), sendResponse);
        case 'replay.locateCandidate':
          if (!matchesFrame(msg.framePath)) return false;
          return reply(locateCandidate(msg.index, msg.fast === true), sendResponse);
        case 'replay.selectAll':
          if (!matchesFrame(msg.framePath)) return false;
          sendResponse(selectAllLocated());
          return false;
        case 'replay.focus':
          if (!matchesFrame(msg.framePath)) return false;
          sendResponse(focusLocated());
          return false;
        case 'replay.verify':
          if (!matchesFrame(msg.framePath)) return false;
          sendResponse(verifyLocated(msg.value));
          return false;
        case 'replay.mark':
          if (!matchesFrame(msg.framePath)) return false;
          sendResponse({ ok: true, mark: pageMark() });
          return false;
        case 'replay.setValue':
          if (!matchesFrame(msg.framePath)) return false;
          return reply(setLocatedValue(msg.value), sendResponse);
        case 'replay.exec': {
          const framePath = ('target' in msg.step ? msg.step.target?.framePath : undefined) ?? [];
          if (!matchesFrame(framePath)) return false;
          return reply(execStep(msg.step, msg.fast === true), sendResponse);
        }
        case 'replay.execCandidate':
          if (!matchesFrame(msg.step.target.framePath)) return false;
          return reply(execCandidate(msg.index, msg.step, msg.fast === true), sendResponse);
        case 'replay.highlight':
          if (!matchesFrame(msg.target.framePath)) return false;
          return reply(
            highlightTarget(msg.target).then((found) => ({ ok: found })),
            sendResponse,
          );
        default:
          return false;
      }
    });
  },
});
