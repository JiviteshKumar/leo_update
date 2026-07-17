// ---------------------------------------------------------------------------
// Workflow model
// ---------------------------------------------------------------------------

// Everything Leo knows about an element at record time. `selectors` is a
// ranked candidate list tried in order at replay; `intent` + `context` are
// the semantic grounding the AI healer uses when every selector has broken.
export interface TargetInfo {
  selectors: string[];
  tag: string;
  text?: string;
  intent: string;
  context?: string;
  // [] = top frame; otherwise the URL (origin + path) of the iframe the
  // element lives in. Replay broadcasts to all frames and only the matching
  // frame executes.
  framePath: string[];
}

export type Step =
  // Explicit navigation (typed URL, reload). Replay drives tabs.update.
  | { type: 'navigate'; url: string }
  // Navigation caused by the previous click/key. Replay just waits for it.
  | { type: 'nav-wait'; urlHint: string }
  | { type: 'click'; target: TargetInfo }
  | { type: 'dblclick'; target: TargetInfo }
  // `secret` steps never store the text; replay pauses for the user.
  | { type: 'type'; target: TargetInfo; text: string; secret: boolean }
  | { type: 'select'; target: TargetInfo; value: string; label: string }
  | { type: 'key'; key: 'Enter' | 'Tab' | 'Escape'; target?: TargetInfo }
  // A file download happened here. Replay waits for it to complete.
  | { type: 'download' };

export type ElementStep = Extract<
  Step,
  { type: 'click' | 'dblclick' | 'type' | 'select' }
>;

export interface Workflow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  startUrl: string;
  steps: Step[];
  // How many times the AI healer has repaired this workflow.
  healCount: number;
}

// ---------------------------------------------------------------------------
// Recording / run state
// ---------------------------------------------------------------------------

export interface RecState {
  active: boolean;
  tabId: number;
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

export interface RunState {
  workflowId: string;
  workflowName: string;
  tabId: number;
  stepIndex: number;
  totalSteps: number;
  status: RunStatus;
  error?: string;
  // Step indexes the AI healer repaired during this run.
  healedSteps: number[];
}

// Replay pacing. 'verbose' mirrors a human user (cursor glide, per-key
// typing, pauses between steps); 'agent' does everything as fast as possible.
export type RunSpeed = 'verbose' | 'agent';

export interface Settings {
  apiKey: string;
  model: string;
  cursorColor: string;
  speed: RunSpeed;
}

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_CURSOR_COLOR = '#4c8bf5';
export const DEFAULT_SPEED: RunSpeed = 'verbose';

// ---------------------------------------------------------------------------
// AI healing
// ---------------------------------------------------------------------------

// Compact description of a live interactive element, sent to the AI healer
// when the recorded selectors no longer match anything.
export interface Candidate {
  index: number;
  tag: string;
  text: string;
  attrs: Record<string, string>;
}

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
  | { kind: 'panel.getSettings' }
  | { kind: 'panel.setSettings'; settings: Settings };

export type ContentMessage =
  | { kind: 'rec.step'; step: Step; replaceLastClicks?: number }
  | { kind: 'rec.isRecording' };

export type BgToContentMessage =
  | { kind: 'replay.ping' }
  | { kind: 'replay.exec'; step: ElementStep | { type: 'key'; key: 'Enter' | 'Tab' | 'Escape'; target?: TargetInfo }; fast?: boolean }
  | { kind: 'replay.execCandidate'; index: number; step: ElementStep; fast?: boolean }
  | { kind: 'replay.highlight'; target: TargetInfo }
  | { kind: 'replay.cursorHide' }
  | { kind: 'rec.attach' }
  | { kind: 'rec.detach' };

export type ExecResult =
  | { ok: true; healedSelectors?: string[] }
  | { ok: false; notFound: true; candidates: Candidate[]; pageTitle: string; pageUrl: string }
  | { ok: false; notFound?: false; error: string };

export interface PanelState {
  rec: RecState | null;
  run: RunState | null;
  workflows: Workflow[];
  hasApiKey: boolean;
}

export const STATE_UPDATE = 'leo.stateUpdate';
