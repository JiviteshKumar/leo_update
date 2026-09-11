// The workflow model and AI wire shapes live in @leo/shared so the extension
// and the web app can never drift apart. Re-exported here so extension code
// keeps a single import path.
export * from '@leo/shared';

import type {
  AgentAction,
  Candidate,
  DragStep,
  ElementStep,
  KeyStep,
  RelPoint,
  Step,
  TargetInfo,
  Workflow,
} from '@leo/shared';

// ---------------------------------------------------------------------------
// Recording / run state
// ---------------------------------------------------------------------------

export interface RecState {
  active: boolean;
  // The tab being recorded. Follows the user into tabs the page opens.
  tabId: number;
  // Tabs that opened the current one (a new tab pushes, closing it pops).
  tabStack: number[];
  startedAt: number;
  steps: Step[];
  // Timestamp of the last click/key step; used to classify navigations.
  lastInteractiveAt: number;
}

export type RunStatus =
  | 'running'
  | 'waiting-user'
  // A step failed; the run is paused so the user can skip it or end the run.
  | 'step-failed'
  | 'done'
  | 'error'
  | 'cancelled';

export interface RunLogEntry {
  index: number;
  type: Step['type'];
  outcome: 'ok' | 'healed' | 'skipped' | 'failed';
  ms: number;
  error?: string;
  // A screenshot of the page was taken when this step failed.
  screenshot?: boolean;
}

export interface RunState {
  workflowId: string;
  workflowName: string;
  // The tab the run is acting in right now.
  tabId: number;
  // Tabs the run came from (a new tab pushes, returning pops).
  tabStack: number[];
  stepIndex: number;
  totalSteps: number;
  status: RunStatus;
  error?: string;
  // What a 'waiting-user' pause is waiting for.
  waitingFor?: 'password' | 'file';
  // Step indexes the AI healer repaired during this run.
  healedSteps: number[];
  // Live activity of a running `agent` step, shown in the run card.
  agentNote?: string;
  // 'native': trusted input through the debugger (the default).
  // 'compatible': page-level events, used when the debugger can't attach or
  // the user dismissed Chrome's debugging bar.
  inputMode: 'native' | 'compatible';
  startedAt: number;
  log: RunLogEntry[];
  // Set when a run stopped early; the panel offers to resume from here.
  resumeFrom?: number;
}

// A finished run, kept (last 20) for troubleshooting.
export interface RunRecord {
  workflowId: string;
  workflowName: string;
  startedAt: number;
  finishedAt: number;
  status: RunStatus;
  error?: string;
  inputMode: RunState['inputMode'];
  steps: RunLogEntry[];
  // JPEG data URL of the page at the last failed step.
  screenshot?: string;
}

// Replay pacing. 'verbose' mirrors a human user (cursor glide, per-key
// typing, pauses between steps); 'agent' does everything as fast as possible.
export type RunSpeed = 'verbose' | 'agent';

export interface Settings {
  cursorColor: string;
  speed: RunSpeed;
}

// Signed-in Leo Cloud user, read from the fe app's better-auth session.
export interface Account {
  name: string;
  email: string;
  image?: string | null;
}

export const DEFAULT_CURSOR_COLOR = '#4c8bf5';
export const DEFAULT_SPEED: RunSpeed = 'verbose';

// Custom-element tag hosting the floating menu's shadow root. Events that
// originate inside the shadow root retarget to this host when observed at
// `window`, so the recorder ignores anything whose target is this tag.
export const LEO_UI_HOST = 'leo-ui';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type PanelMessage =
  | { kind: 'panel.getState' }
  | { kind: 'panel.startRecording' }
  | { kind: 'panel.stopRecording'; name: string }
  | { kind: 'panel.discardRecording' }
  | { kind: 'panel.deleteWorkflow'; id: string }
  | { kind: 'panel.renameWorkflow'; id: string; name: string }
  | { kind: 'panel.run'; id: string }
  | { kind: 'panel.cancelRun' }
  // Clear a finished (done/error/cancelled) run so its card disappears.
  | { kind: 'panel.dismissRun' }
  | { kind: 'panel.continueRun' }
  | { kind: 'panel.skipStep' }
  // Re-run the step that just failed.
  | { kind: 'panel.retryStep' }
  // Continue a stopped run from the step it stopped at, in the same tab.
  | { kind: 'panel.resumeRun' }
  // The screenshot taken when the current run's last step failed.
  | { kind: 'panel.getFailureShot' }
  | { kind: 'panel.getSettings' }
  | { kind: 'panel.setSettings'; settings: Settings }
  | { kind: 'panel.getAccount'; refresh?: boolean }
  // Opens the fe app in a tab so the user can sign in there.
  | { kind: 'panel.signIn' }
  | { kind: 'panel.signOut' }
  // Replace a saved workflow's steps (the step editor: delete steps, insert
  // AI-instruction steps).
  | { kind: 'panel.updateWorkflowSteps'; id: string; steps: Step[] };

export type ContentMessage =
  | { kind: 'rec.step'; step: Step; replaceLastClicks?: number }
  | { kind: 'rec.isRecording' };

// Messages carrying a target or framePath are handled only by the frame the
// element lives in; everything else is handled by the top frame.
export type BgToContentMessage =
  | { kind: 'replay.ping' }
  // Native input: find the element, wait until it can receive a click, and
  // report its center in top-level viewport coordinates for the debugger.
  // `pos` picks the point inside the element (default: center). When the
  // element exists but is hidden, the reply may ask for a hover first
  // (menus that open on hover) unless `hover` is false.
  | { kind: 'replay.locate'; target: TargetInfo; fast?: boolean; timeoutMs?: number; pos?: RelPoint; hover?: boolean }
  // Compatible-mode drag with page-level events.
  | { kind: 'replay.drag'; step: DragStep; fast?: boolean }
  | { kind: 'replay.locateCandidate'; index: number; framePath: string[]; fast?: boolean }
  // Follow-ups on the element the last locate returned in that frame.
  | { kind: 'replay.selectAll'; framePath: string[] }
  | { kind: 'replay.focus'; framePath: string[] }
  | { kind: 'replay.verify'; framePath: string[]; value: string }
  | { kind: 'replay.setValue'; framePath: string[]; value: string }
  // Compatible input: the content script finds and acts on the element with
  // page-level events. Also used for native <select>.
  | { kind: 'replay.exec'; step: ElementStep | KeyStep; fast?: boolean }
  | { kind: 'replay.execCandidate'; index: number; step: ElementStep; fast?: boolean }
  | { kind: 'replay.highlight'; target: TargetInfo }
  // Resolves once the page stops changing (or maxMs passes).
  | { kind: 'replay.settle'; quietMs: number; maxMs: number }
  | { kind: 'replay.cursorHide' }
  // Agent step (top frame): snapshot the page; locate an action's element
  // for native input; or perform the action with page-level events.
  | { kind: 'agent.snapshot' }
  | { kind: 'agent.locate'; action: AgentAction }
  | { kind: 'agent.act'; action: AgentAction }
  | { kind: 'rec.attach' }
  | { kind: 'rec.detach' }
  // Hide Leo's floating menu for a moment if it covers this point, so a
  // replayed click lands on the page underneath.
  | { kind: 'ui.clearPoint'; x: number; y: number }
  // Presence check for the floating-menu content script. Visibility itself is
  // driven by a storage.local flag watched via storage.onChanged, not by
  // messages — this only lets the background detect a tab that has no menu
  // yet (opened before the extension loaded) so it can inject one.
  | { kind: 'ui.ping' };

export type ExecResult =
  | { ok: true; healedSelectors?: string[] }
  | { ok: false; notFound: true; candidates: Candidate[]; pageTitle: string; pageUrl: string }
  | { ok: false; notFound?: false; error: string };

export type LocateResult =
  // `inputType` is set for <input> elements (date/time/range inputs are
  // set directly rather than typed into).
  | { ok: true; x: number; y: number; healedSelectors?: string[]; inputType?: string }
  | { ok: false; notFound: true; candidates: Candidate[]; pageTitle: string; pageUrl: string }
  // The element exists but is hidden: move the mouse here (top-level
  // coordinates) to reveal it, then locate again.
  | { ok: false; notFound?: false; hover: { x: number; y: number } }
  | { ok: false; notFound?: false; error: string };

export interface PanelState {
  rec: RecState | null;
  run: RunState | null;
  workflows: Workflow[];
}

export const STATE_UPDATE = 'leo.stateUpdate';
