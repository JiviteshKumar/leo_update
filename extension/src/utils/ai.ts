import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY } from './env';
import type {
  AgentAction,
  AgentSnapshot,
  Candidate,
  Settings,
  TargetInfo,
} from './types';

// AI self-healing: when every recorded selector fails, ask Claude to match
// the step's intent against the live page's interactive elements. Structured
// outputs guarantee a parseable verdict. Runs in the extension service
// worker with the build-time API key (env.ts), hence dangerouslyAllowBrowser.

export interface HealVerdict {
  match: number | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

const VERDICT_SCHEMA = {
  type: 'object' as const,
  properties: {
    match: {
      type: ['integer', 'null'],
      description:
        'Index of the candidate element that is the same control the user originally interacted with, or null if none matches.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'One short sentence.' },
  },
  required: ['match', 'confidence', 'reason'],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  'You repair broken browser automations. A recorded workflow step can no ' +
  'longer find its target element because the website changed. You are given ' +
  'the original step (intent, element tag, visible text, old selectors, ' +
  'nearby text) and a numbered list of interactive elements currently ' +
  'visible on the page. Pick the candidate that is the SAME control the ' +
  'user originally interacted with. Match on purpose and meaning, not on ' +
  'exact attribute equality. If no candidate plausibly serves the same ' +
  'purpose, return null rather than guessing.';

export const healStep = async (
  settings: Settings,
  step: { intent: string; target: TargetInfo },
  candidates: Candidate[],
  page: { title: string; url: string },
): Promise<HealVerdict> => {
  const client = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    dangerouslyAllowBrowser: true,
  });

  const candidateLines = candidates
    .map((c) => {
      const attrs = Object.entries(c.attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `[${c.index}] <${c.tag}${attrs ? ' ' + attrs : ''}> ${c.text || '(no text)'}`;
    })
    .join('\n');

  const user = [
    `Page: ${page.title} (${page.url})`,
    '',
    'Original step:',
    `- Intent: ${step.intent}`,
    `- Element: <${step.target.tag}> ${step.target.text ?? ''}`,
    `- Old selectors (all failed): ${step.target.selectors.join(' | ')}`,
    step.target.context ? `- Text near the element when recorded: ${step.target.context}` : '',
    '',
    'Interactive elements on the page right now:',
    candidateLines || '(none found)',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: {
      format: {
        type: 'json_schema',
        schema: VERDICT_SCHEMA,
      },
    },
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') {
    return { match: null, confidence: 'low', reason: 'model declined the request' };
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const verdict = JSON.parse(text) as HealVerdict;
  if (verdict.match != null && (verdict.match < 0 || verdict.match >= candidates.length)) {
    return { match: null, confidence: 'low', reason: 'model returned an invalid index' };
  }
  return verdict;
};

// ---------------------------------------------------------------------------
// AI agent: achieve a natural-language goal by looping observe → act. Each
// turn combines a screenshot (visual layout — date pickers, custom widgets)
// with the DOM candidate list (reliable targeting by index).
// ---------------------------------------------------------------------------

const AGENT_MAX_STEPS = 16;

const AGENT_SYSTEM =
  'You drive a web page to accomplish a goal on the user\'s behalf. Each turn ' +
  'you see a screenshot of the page plus a numbered list of the interactive ' +
  'elements on it, with their bounding boxes as "@ (x,y wxh)" in screenshot ' +
  'pixels — use the boxes to match list entries to what you see. Prefer ' +
  'acting on elements by [index] with click/type/press_key. If the control ' +
  'you can see has no matching list entry, use click_at(x, y) with the ' +
  'coordinates of its center in the screenshot. Use scroll(dy) if the target ' +
  'is off-screen. After every action you get a fresh screenshot and list — ' +
  're-read them, since indexes change. Orient yourself from what is visible ' +
  '(e.g. the month shown in a date picker) and compute relative goals from ' +
  'the given current date. Take the smallest number of steps. Call ' +
  'finish(success=true) the moment the goal is met, or finish(success=false, ' +
  'note) if it is impossible.';

const AGENT_TOOLS = [
  {
    name: 'click',
    description: 'Click the interactive element at the given index.',
    input_schema: {
      type: 'object' as const,
      properties: { index: { type: 'integer' } },
      required: ['index'],
    },
  },
  {
    name: 'type',
    description: 'Focus the element at index and type the given text into it.',
    input_schema: {
      type: 'object' as const,
      properties: { index: { type: 'integer' }, text: { type: 'string' } },
      required: ['index', 'text'],
    },
  },
  {
    name: 'press_key',
    description:
      'Press a single key (Enter, Escape, Tab, ArrowUp/Down/Left/Right) on the element at index.',
    input_schema: {
      type: 'object' as const,
      properties: { index: { type: 'integer' }, key: { type: 'string' } },
      required: ['index', 'key'],
    },
  },
  {
    name: 'click_at',
    description:
      'Click at a screenshot coordinate. Use ONLY when no listed element ' +
      'matches the control you can see; prefer click(index) otherwise.',
    input_schema: {
      type: 'object' as const,
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page vertically by dy pixels (positive = down, negative = up).',
    input_schema: {
      type: 'object' as const,
      properties: { dy: { type: 'integer' } },
      required: ['dy'],
    },
  },
  {
    name: 'finish',
    description: 'End the task. Set success=true only if the goal was achieved.',
    input_schema: {
      type: 'object' as const,
      properties: {
        success: { type: 'boolean' },
        note: { type: 'string', description: 'One short sentence.' },
      },
      required: ['success', 'note'],
    },
  },
];

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
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: image },
    });
  }
  blocks.push({ type: 'text', text: renderSnapshot(snap, resultNote) });
  return blocks;
};

export const runAgentStep = async (
  settings: Settings,
  goal: string,
  now: Date,
  observe: () => Promise<AgentSnapshot>,
  act: (action: AgentAction) => Promise<{ ok: boolean; error?: string }>,
  // Returns a base64 JPEG of the tab, downscaled so 1 image px == 1 CSS px
  // (candidate rects and click_at coordinates line up with the image), or
  // null when capture fails — the loop then runs text-only for that turn.
  capture: (dpr: number) => Promise<string | null>,
  onProgress?: (note: string) => void,
): Promise<{ success: boolean; note: string }> => {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY, dangerouslyAllowBrowser: true });

  const first = await observe();
  const firstShot = await capture(first.viewport.dpr);
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `Goal: ${goal}\n` +
            `Current date: ${now.toDateString()} (ISO ${now.toISOString().slice(0, 10)}).`,
        },
        ...observationContent(first, firstShot),
      ],
    },
  ];

  for (let i = 0; i < AGENT_MAX_STEPS; i++) {
    const resp = await client.messages.create({
      model: settings.model,
      max_tokens: 1024,
      system: AGENT_SYSTEM,
      tools: AGENT_TOOLS,
      messages,
    });
    if (resp.stop_reason === 'refusal') {
      return { success: false, note: 'the model declined the request' };
    }
    messages.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      return { success: false, note: 'the agent stopped without finishing' };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === 'finish') {
        const input = tu.input as { success?: boolean; note?: string };
        onProgress?.(input.note ?? '');
        return { success: Boolean(input.success), note: input.note ?? '' };
      }
      const action = toAction(tu.name, (tu.input ?? {}) as Record<string, unknown>);
      let note: string;
      if (!action) {
        note = `unknown or malformed tool call: ${tu.name}`;
      } else {
        onProgress?.(actionLabel(action));
        const r = await act(action);
        note = r.ok ? 'done' : `failed: ${r.error ?? 'error'}`;
      }
      const snap = await observe();
      const shot = await capture(snap.viewport.dpr);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: observationContent(snap, shot, note),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return { success: false, note: `did not finish within ${AGENT_MAX_STEPS} steps` };
};

// Goal text for vision-agent recovery of one failed recorded step. Kept pure
// so it can be tested; the background wires it to runAgentStep.
export const recoveryGoal = (step: {
  type: string;
  target: TargetInfo;
  text?: string;
  secret?: boolean;
}): string =>
  `Complete this single action from a recorded browser workflow, then finish: ` +
  `${step.target.intent}.` +
  (step.target.text ? ` The original element's text was "${step.target.text}".` : '') +
  (step.target.context
    ? ` Text near it when recorded: "${step.target.context.slice(0, 150)}".`
    : '') +
  (step.type === 'type' && !step.secret && step.text ? ` Text to type: "${step.text}".` : '');

export const describeAiError = (err: unknown): string => {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic API key was rejected. Check WXT_ANTHROPIC_API_KEY in extension/.env and rebuild.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Anthropic API rate limit hit. Try again in a minute.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
};
