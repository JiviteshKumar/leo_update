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

// Held modifiers for a key press. Absent flags are false.
export interface KeyMods {
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
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
  // A discrete key press: named non-printable keys (Enter, Tab, Escape,
  // Arrow*, …) and keyboard shortcuts (`mods` holds ctrl/meta/alt/shift).
  // Plain printable typing is captured as `type` steps, not here.
  | { type: 'key'; key: string; mods?: KeyMods; target?: TargetInfo }
  // A file download happened here. Replay waits for it to complete.
  | { type: 'download' }
  // A natural-language goal achieved by the AI agent at run time. For dynamic
  // actions that can't be a fixed click — "select last month", "pick the first
  // available slot". Authored by the user, not recorded.
  | { type: 'agent'; goal: string };

export type ElementStep = Extract<
  Step,
  { type: 'click' | 'dblclick' | 'type' | 'select' }
>;

export type KeyStep = Extract<Step, { type: 'key' }>;

export interface Workflow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  startUrl: string;
  steps: Step[];
  // How many times the AI healer has repaired this workflow.
  healCount: number;
  // One-line description of what the workflow accomplishes, derived by AI at
  // record time. Fed to the healer/agent as global context so a broken or
  // dynamic step is resolved with knowledge of the overall goal.
  objective?: string;
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
  // Live activity of a running `agent` step, shown in the run card.
  agentNote?: string;
}

// Replay pacing. 'verbose' mirrors a human user (cursor glide, per-key
// typing, pauses between steps); 'agent' does everything as fast as possible.
export type RunSpeed = 'verbose' | 'agent';

// The Anthropic API key is not a setting: it's baked in at build time from
// extension/.env (see src/utils/env.ts).
export interface Settings {
  model: string;
  cursorColor: string;
  speed: RunSpeed;
}

// Signed-in Leo Cloud user, read from the fe app's better-auth session.
export interface Account {
  name: string;
  email: string;
  image?: string | null;
}

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_CURSOR_COLOR = '#4c8bf5';
export const DEFAULT_SPEED: RunSpeed = 'verbose';

// Custom-element tag hosting the floating menu's shadow root. Events that
// originate inside the shadow root retarget to this host when observed at
// `window`, so the recorder ignores anything whose target is this tag.
export const LEO_UI_HOST = 'leo-ui';

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
  // Viewport-relative bounding box in CSS px. Filled by agentSnapshot() so
  // the vision agent can correlate candidates with the screenshot; the
  // text-only healer path leaves it unset.
  rect?: { x: number; y: number; w: number; h: number };
}

// ---------------------------------------------------------------------------
// AI agent (dynamic `agent` steps + failed-step recovery)
// ---------------------------------------------------------------------------

// What the agent observes each turn: the numbered interactive elements it can
// act on (by index), plus page text for context (dates, month labels, …).
export interface AgentSnapshot {
  candidates: Candidate[];
  pageText: string;
  title: string;
  url: string;
  // Screenshots are downscaled to CSS-px size, so candidate rects and
  // click_at coordinates line up 1:1 with image pixels.
  viewport: { w: number; h: number; dpr: number };
}

// An action the agent takes: on a candidate by its snapshot index, at a
// screenshot coordinate (elements the DOM sweep missed), or a page scroll.
export type AgentAction =
  | { kind: 'click'; index: number }
  | { kind: 'type'; index: number; text: string }
  | { kind: 'key'; index: number; key: string }
  | { kind: 'clickAt'; x: number; y: number }
  | { kind: 'scroll'; dy: number };

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
  // Opens the fe app in a tab so the user can sign in with Google there.
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
