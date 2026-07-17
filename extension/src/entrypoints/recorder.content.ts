import { attachRecorder } from '@/utils/recorder';
import { execCandidate, execStep, highlightTarget } from '@/utils/replayer';
import { cursorHide } from '@/utils/cursor';
import { matchesFrame } from '@/utils/selectors';
import type { BgToContentMessage, ExecResult, Step } from '@/utils/types';

// Runs on every page and frame. Two jobs:
//  - Recording: attach DOM listeners when the background says this tab is
//    being recorded (re-attaches automatically after each navigation).
//  - Replay: execute steps the background sends, in the frame whose URL
//    matches the step's framePath.

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    let detach: (() => void) | null = null;

    const startRecording = () => {
      if (detach) return;
      detach = attachRecorder((step: Step, replaceLastClicks?: number) => {
        // After an extension reload this script is orphaned and sendMessage
        // throws synchronously; guard so a stray user event can't surface an
        // uncaught "Extension context invalidated".
        try {
          if (!browser.runtime?.id) return;
          void browser.runtime
            .sendMessage({ kind: 'rec.step', step, replaceLastClicks })
            .catch(() => {
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

    // On load, ask whether this tab is mid-recording (survives navigations).
    const checkRecording = async () => {
      try {
        const res = (await browser.runtime.sendMessage({
          kind: 'rec.isRecording',
        })) as { recording: boolean } | undefined;
        if (res?.recording) startRecording();
      } catch {
        // extension context not ready
      }
    };
    void checkRecording();

    browser.runtime.onMessage.addListener(
      (msg: BgToContentMessage, _sender, sendResponse) => {
        switch (msg.kind) {
          case 'rec.attach': {
            startRecording();
            sendResponse({ ok: true });
            return false;
          }
          case 'rec.detach': {
            stopRecording();
            sendResponse({ ok: true });
            return false;
          }
          case 'replay.ping': {
            // Only the top frame answers, so the background gets one reply.
            if (window.top !== window) return false;
            sendResponse({ ok: true });
            return false;
          }
          case 'replay.cursorHide': {
            cursorHide();
            return false;
          }
          case 'replay.exec': {
            const target = 'target' in msg.step ? msg.step.target : undefined;
            const framePath = target?.framePath ?? [];
            if (!matchesFrame(framePath)) return false;
            void execStep(msg.step, msg.fast === true).then((result: ExecResult) =>
              sendResponse(result),
            );
            return true;
          }
          case 'replay.execCandidate': {
            if (!matchesFrame(msg.step.target.framePath)) return false;
            void execCandidate(msg.index, msg.step, msg.fast === true).then(
              (result: ExecResult) => sendResponse(result),
            );
            return true;
          }
          case 'replay.highlight': {
            if (!matchesFrame(msg.target.framePath)) return false;
            void highlightTarget(msg.target).then((found) =>
              sendResponse({ ok: found }),
            );
            return true;
          }
          default:
            return false;
        }
      },
    );

    // Recording state can end while a page is open; background broadcasts
    // stop via a detach message. Also flush pending typing before unload.
    window.addEventListener('pagehide', () => {
      // attachRecorder's own pagehide handler flushes; nothing extra here.
    });
  },
});
