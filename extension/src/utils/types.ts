// The workflow model and AI wire shapes live in @leo/shared so the extension
// and the web app can never drift apart. Re-exported here so extension code
// keeps a single import path.
export * from '@leo/shared';

import type {
  AgentAction,
  Candidate,
  ElementStep,
  KeyStep,
  Step,
  TargetInfo,
  Workflow,
} from '@leo/shared';

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
  // Live activity of a running `agent` step, shown in the run card.
  agentNote?: string;
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

export type BgToContentMessage =
  | { kind: 'replay.ping' }
  | { kind: 'replay.exec'; step: ElementStep | KeyStep; fast?: boolean }
  | { kind: 'replay.execCandidate'; index: number; step: ElementStep; fast?: boolean }
  | { kind: 'replay.highlight'; target: TargetInfo }
  | { kind: 'replay.cursorHide' }
  // Agent step: snapshot the page, or act on a candidate by index. Handled by
  // the top frame only.
  | { kind: 'agent.snapshot' }
  | { kind: 'agent.act'; action: AgentAction }
  | { kind: 'rec.attach' }
  | { kind: 'rec.detach' }
  // Presence check for the floating-menu content script. Visibility itself is
  // driven by a storage.local flag watched via storage.onChanged, not by
  // messages — this only lets the background detect a tab that has no menu
  // yet (opened before the extension loaded) so it can inject one.
  | { kind: 'ui.ping' };

export type ExecResult =
  | { ok: true; healedSelectors?: string[] }
  | { ok: false; notFound: true; candidates: Candidate[]; pageTitle: string; pageUrl: string }
  | { ok: false; notFound?: false; error: string };

export interface PanelState {
  rec: RecState | null;
  run: RunState | null;
  workflows: Workflow[];
}

export const STATE_UPDATE = 'leo.stateUpdate';
