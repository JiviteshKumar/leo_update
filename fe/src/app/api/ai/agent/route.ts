import type Anthropic from '@anthropic-ai/sdk';
import { AI_MAX_TOKENS, AI_MODEL, aiRoute } from '@/lib/ai/anthropic';
import { parseAgentMessages } from '@/lib/ai/requests';

// One turn of the browser agent. The extension runs the observe → act loop
// against the real tab and posts the conversation so far; this route adds the
// system prompt and tools and returns the model's next move.

// Long agent turns can take a while on hosted platforms.
export const maxDuration = 120;

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
    description:
      'Press a single key (Enter, Escape, Tab, ArrowUp/Down/Left/Right) on the element at index.',
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

export const POST = aiRoute('agent', { limit: 120, windowMs: 60_000 }, async (body, client) => {
  const messages = parseAgentMessages(body);
  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    // The whole conversation (tools + system + every prior screenshot) is
    // re-sent each turn; automatic caching serves that growing prefix from
    // cache instead of full price.
    cache_control: { type: 'ephemeral' },
    system: AGENT_SYSTEM,
    tools: AGENT_TOOLS,
    messages,
  });
  return { content: response.content, stop_reason: response.stop_reason };
});
