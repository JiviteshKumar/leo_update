import type Anthropic from '@anthropic-ai/sdk';
import { describeStep, validateSteps, type HealVerdict, type ObjectiveResponse } from '@leo/shared';
import type { AgentTurn, AiProvider } from './providers';
import { BadRequest, parseAgentMessages, parseHealRequest, renderHealPrompt } from './requests';

// Leo's AI features: prompts, schemas and tools, independent of the model
// provider (see ./providers). No Next.js imports, so the same code serves the
// /api/ai/* routes and the e2e suite's live mode.

export { createProvider } from './providers';

// The model declined the request.
export class Refused extends Error {}

// ---------------------------------------------------------------------------
// Healer: when every recorded selector fails, match the step's intent
// against the live page's interactive elements.
// ---------------------------------------------------------------------------

const VERDICT_SCHEMA = {
  type: 'object',
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

const HEAL_SYSTEM =
  'You repair broken browser automations. A recorded workflow step can no ' +
  'longer find its target element because the website changed. You are given ' +
  'the original step (intent, element tag, visible text, old selectors, ' +
  'nearby text) and a numbered list of interactive elements currently ' +
  'visible on the page. Pick the candidate that is the SAME control the ' +
  'user originally interacted with. Match on purpose and meaning, not on ' +
  'exact attribute equality. If no candidate plausibly serves the same ' +
  'purpose, return null rather than guessing. Use "low" confidence whenever ' +
  'more than one candidate could plausibly be the control.';

const noMatch = (reason: string): HealVerdict => ({ match: null, confidence: 'low', reason });

export const heal = async (body: unknown, ai: AiProvider): Promise<HealVerdict> => {
  const req = parseHealRequest(body);
  if (req.candidates.length === 0) return noMatch('no interactive elements on the page');

  let raw: unknown;
  try {
    raw = await ai.json({
      system: HEAL_SYSTEM,
      user: renderHealPrompt(req),
      schema: VERDICT_SCHEMA,
      schemaName: 'heal_verdict',
    });
  } catch (err) {
    if (err instanceof SyntaxError) return noMatch('model returned no verdict');
    throw err;
  }
  if (raw == null) return noMatch('model declined the request');
  const v = raw as Partial<HealVerdict>;
  const confidence = v.confidence === 'high' || v.confidence === 'medium' ? v.confidence : 'low';
  const match = typeof v.match === 'number' ? v.match : null;
  if (match != null && (!Number.isInteger(match) || match < 0 || match >= req.candidates.length)) {
    return noMatch('model returned an invalid index');
  }
  return { match, confidence, reason: typeof v.reason === 'string' ? v.reason : '' };
};

// ---------------------------------------------------------------------------
// Objective: one call at record time that turns the step list into a name
// and a one-line goal, later fed to the healer/agent as context.
// ---------------------------------------------------------------------------

const OBJECTIVE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'A short imperative title, at most 6 words.' },
    objective: {
      type: 'string',
      description: 'One sentence: what the whole workflow accomplishes for the user.',
    },
  },
  required: ['name', 'objective'],
  additionalProperties: false,
};

const OBJECTIVE_SYSTEM =
  'You summarize a recorded browser automation. Given its ordered steps, ' +
  'return a short imperative name and a one-sentence objective describing ' +
  'what the whole workflow accomplishes for the user. Be concrete; name the ' +
  'site or task when it is clear from the steps.';

export const objective = async (body: unknown, ai: AiProvider): Promise<ObjectiveResponse> => {
  const steps = validateSteps((body as { steps?: unknown } | null)?.steps);
  if (!steps.ok) throw new BadRequest(steps.error);
  const lines = steps.value
    .slice(0, 200)
    .map((s, i) => `${i + 1}. ${describeStep(s)}`)
    .join('\n');

  const raw = await ai.json({
    system: OBJECTIVE_SYSTEM,
    user: `Steps:\n${lines}`,
    schema: OBJECTIVE_SCHEMA,
    schemaName: 'workflow_summary',
  });
  if (raw == null) throw new Refused();
  const parsed = raw as Partial<ObjectiveResponse>;
  return {
    name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
    objective: typeof parsed.objective === 'string' ? parsed.objective.trim() : '',
  };
};

// ---------------------------------------------------------------------------
// Agent: one turn. The extension runs the observe → act loop against the
// real tab and posts the conversation so far; this adds the system prompt
// and tools and returns the model's next move.
// ---------------------------------------------------------------------------

const AGENT_SYSTEM =
  "You drive a web page to accomplish a goal on the user's behalf. Each turn " +
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

const TEXT_ONLY_NOTE =
  '\n\nIn this session screenshots are NOT available: work only from the ' +
  'numbered element list (with its bounding boxes) and the visible page ' +
  'text. Use the boxes to reason about layout, e.g. which arrow is "next" ' +
  'and which day cells belong to which row. Act with one tool call per turn.';

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'click',
    description: 'Click the interactive element at the given index.',
    input_schema: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] },
  },
  {
    name: 'type',
    description: 'Focus the element at index and type the given text into it (replacing its content).',
    input_schema: {
      type: 'object',
      properties: { index: { type: 'integer' }, text: { type: 'string' } },
      required: ['index', 'text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a single key (Enter, Escape, Tab, ArrowUp/Down/Left/Right) on the element at index.',
    input_schema: {
      type: 'object',
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
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page vertically by dy pixels (positive = down, negative = up).',
    input_schema: { type: 'object', properties: { dy: { type: 'integer' } }, required: ['dy'] },
  },
  {
    name: 'finish',
    description: 'End the task. Set success=true only if the goal was achieved.',
    input_schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        note: { type: 'string', description: 'One short sentence.' },
      },
      required: ['success', 'note'],
    },
  },
];

export const agentTurn = async (body: unknown, ai: AiProvider): Promise<AgentTurn> => {
  const messages = parseAgentMessages(body);
  return ai.agentTurn({
    system: ai.vision ? AGENT_SYSTEM : AGENT_SYSTEM + TEXT_ONLY_NOTE,
    tools: AGENT_TOOLS,
    messages,
  });
};
