// ---------------------------------------------------------------------------
// Workflow model — the single source of truth for the extension (which
// records and replays it) and the web app (which syncs and stores it).
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

export type StepType = Step['type'];

export type ElementStep = Extract<Step, { type: 'click' | 'dblclick' | 'type' | 'select' }>;

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
// AI healing / agent — the live-page shapes the extension sends to the web
// app's /api/ai/* endpoints.
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

export interface HealVerdict {
  match: number | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface HealRequest {
  step: { intent: string; target: TargetInfo };
  candidates: Candidate[];
  page: { title: string; url: string };
  objective?: string;
}

export interface ObjectiveRequest {
  steps: Step[];
}

export interface ObjectiveResponse {
  name: string;
  objective: string;
}

// Error body every /api/ai/* endpoint returns on failure. `code` lets the
// extension show an actionable message without string-matching.
export type AiErrorCode =
  | 'unauthorized'
  | 'rate_limited'
  | 'bad_request'
  | 'not_configured'
  | 'provider_auth'
  | 'provider_rate_limited'
  | 'provider_error'
  | 'refused';

export interface AiErrorBody {
  error: string;
  code: AiErrorCode;
}
