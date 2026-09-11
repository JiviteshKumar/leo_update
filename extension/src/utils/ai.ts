import type Anthropic from '@anthropic-ai/sdk';
import { FE_URL } from './env';
import type {
  AgentAction,
  AgentSnapshot,
  AiErrorBody,
  AiErrorCode,
  HealRequest,
  HealVerdict,
  ObjectiveResponse,
  PerformedAction,
  Step,
} from './types';

// Client side of Leo's AI features. The model, prompts and API key live in
// the web app (fe/src/lib/ai); the extension only sends the live-page data
// and, for the agent, drives the observe → act loop against the real tab.
// Every call is authenticated by the user's Leo session cookie.

export type AiFailure = AiErrorCode | 'network' | 'cancelled';

export class AiError extends Error {
  constructor(
    message: string,
    readonly code: AiFailure,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

const post = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`${FE_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal?.aborted) throw new AiError('Cancelled.', 'cancelled');
    throw new AiError(`Could not reach Leo Cloud (${FE_URL}).`, 'network');
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as AiErrorBody | null;
    throw new AiError(err?.error ?? `Leo Cloud returned HTTP ${res.status}.`, err?.code ?? 'provider_error');
  }
  return (await res.json()) as T;
};

// One sentence the run card can show for any AI failure.
export const describeAiError = (err: unknown): string => {
  if (err instanceof AiError) {
    switch (err.code) {
      case 'unauthorized':
        return 'Sign in to Leo to use AI repair and AI steps.';
      case 'rate_limited':
      case 'provider_rate_limited':
        return 'AI is busy right now (rate limit). Retry in a minute.';
      case 'not_configured':
        return 'AI is not configured on the Leo server (ANTHROPIC_API_KEY is missing).';
      case 'network':
        return err.message;
      default:
        return `AI error: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
};

// ---------------------------------------------------------------------------
// Healer + objective
// ---------------------------------------------------------------------------

export const healStep = (req: HealRequest): Promise<HealVerdict> =>
  post<HealVerdict>('/api/ai/heal', req);

// Best-effort: a missing objective only means less context for later repairs.
export const deriveObjective = async (steps: Step[]): Promise<ObjectiveResponse | null> => {
  try {
    return await post<ObjectiveResponse>('/api/ai/objective', { steps });
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// AI agent: achieve a natural-language goal by looping observe → act. Each
// turn combines a screenshot (visual layout — date pickers, custom widgets)
// with the DOM candidate list (reliable targeting by index).
// ---------------------------------------------------------------------------

const AGENT_MAX_STEPS = 16;

interface AgentTurnResponse {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.StopReason | null;
}

const renderSnapshot = (s: AgentSnapshot, resultNote?: string): string => {
  const lines = s.candidates.map((c) => {
    const attrs = Object.entries(c.attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    const box = c.rect ? ` @ (${c.rect.x},${c.rect.y} ${c.rect.w}x${c.rect.h})` : '';
    return `[${c.index}] <${c.tag}${attrs ? ' ' + attrs : ''}> ${c.text || '(no text)'}${box}`;
  });
  return [
    resultNote ? `Last action: ${resultNote}` : '',
    `Page: ${s.title} (${s.url})`,
    `Viewport: ${s.viewport.w}x${s.viewport.h}`,
    'Interactive elements:',
    lines.join('\n') || '(none found)',
    '',
    `Visible text: ${s.pageText.slice(0, 1500)}`,
  ]
    .filter(Boolean)
    .join('\n');
};

const toAction = (name: string, input: Record<string, unknown>): AgentAction | null => {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  if (name === 'click_at') {
    const x = num(input.x);
    const y = num(input.y);
    return x != null && y != null ? { kind: 'clickAt', x, y } : null;
  }
  if (name === 'scroll') {
    const dy = num(input.dy);
    return dy != null ? { kind: 'scroll', dy } : null;
  }
  const index = num(input.index);
  if (index == null) return null;
  if (name === 'click') return { kind: 'click', index };
  if (name === 'type') return { kind: 'type', index, text: String(input.text ?? '') };
  if (name === 'press_key') return { kind: 'key', index, key: String(input.key ?? '') };
  return null;
};

const actionLabel = (a: AgentAction): string => {
  switch (a.kind) {
    case 'type':
      return `Typing "${a.text.slice(0, 20)}" into [${a.index}]`;
    case 'key':
      return `Pressing ${a.key} on [${a.index}]`;
    case 'clickAt':
      return `Clicking at (${a.x}, ${a.y})`;
    case 'scroll':
      return `Scrolling ${a.dy > 0 ? 'down' : 'up'}`;
    default:
      return `Clicking [${a.index}]`;
  }
};

// One observation for the model: screenshot (when available) + text snapshot.
const observationContent = (
  snap: AgentSnapshot,
  image: string | null,
  resultNote?: string,
): (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] => {
  const blocks: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
  if (image) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
  }
  blocks.push({ type: 'text', text: renderSnapshot(snap, resultNote) });
  return blocks;
};

export interface AgentRunResult {
  success: boolean;
  note: string;
  performed: PerformedAction[];
}

export interface AgentIO {
  observe: () => Promise<AgentSnapshot>;
  act: (action: AgentAction) => Promise<{ ok: boolean; error?: string; healedSelectors?: string[] }>;
  // Returns a base64 JPEG of the run tab, downscaled so 1 image px == 1 CSS
  // px (candidate rects and click_at coordinates line up with the image), or
  // null when capture fails — the loop then runs text-only for that turn.
  capture: (dpr: number) => Promise<string | null>;
  onProgress?: (note: string) => void;
  // Aborts the in-flight model call and stops the loop (End run).
  signal?: AbortSignal;
}

export const runAgentStep = async (
  goal: string,
  now: Date,
  io: AgentIO,
  objective?: string,
): Promise<AgentRunResult> => {
  const performed: PerformedAction[] = [];
  const checkCancelled = () => {
    if (io.signal?.aborted) throw new AiError('Cancelled.', 'cancelled');
  };

  const first = await io.observe();
  const firstShot = await io.capture(first.viewport.dpr);
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            (objective ? `Workflow goal: ${objective}\n` : '') +
            `This step: ${goal}\n` +
            `Current date: ${now.toDateString()} (ISO ${now.toISOString().slice(0, 10)}).`,
        },
        ...observationContent(first, firstShot),
      ],
    },
  ];

  for (let i = 0; i < AGENT_MAX_STEPS; i++) {
    checkCancelled();
    const resp = await post<AgentTurnResponse>('/api/ai/agent', { messages }, io.signal);
    if (resp.stop_reason === 'refusal') {
      return { success: false, note: 'the model declined the request', performed };
    }
    messages.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      return { success: false, note: 'the agent stopped without finishing', performed };
    }

    // Every tool_use must get a tool_result in the next user turn, so the
    // loop answers all of them even when one fails.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === 'finish') {
        const input = tu.input as { success?: boolean; note?: string };
        io.onProgress?.(input.note ?? '');
        return { success: Boolean(input.success), note: input.note ?? '', performed };
      }
      checkCancelled();
      const action = toAction(tu.name, (tu.input ?? {}) as Record<string, unknown>);
      let note: string;
      if (!action) {
        note = `unknown or malformed tool call: ${tu.name}`;
      } else {
        io.onProgress?.(actionLabel(action));
        const r = await io.act(action);
        note = r.ok ? 'done' : `failed: ${r.error ?? 'error'}`;
        if (r.ok) performed.push({ action, healedSelectors: r.healedSelectors });
      }
      const snap = await io.observe();
      const shot = await io.capture(snap.viewport.dpr);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: observationContent(snap, shot, note),
        ...(action && note !== 'done' ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return { success: false, note: `did not finish within ${AGENT_MAX_STEPS} steps`, performed };
};
