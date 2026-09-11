import type Anthropic from '@anthropic-ai/sdk';
import type { Candidate, HealRequest, TargetInfo } from '@leo/shared';

// Request parsing for the /api/ai/* endpoints. Pure (no Next or SDK runtime
// imports) so it can be unit-tested directly.

export class BadRequest extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown, path: string, max = 5_000): string => {
  if (typeof v !== 'string') throw new BadRequest(`${path} must be a string`);
  return v.slice(0, max);
};

const optStr = (v: unknown, path: string, max = 5_000): string | undefined =>
  v === undefined || v === null ? undefined : str(v, path, max);

const parseTarget = (v: unknown): TargetInfo => {
  if (!isObj(v)) throw new BadRequest('step.target must be an object');
  const selectors = Array.isArray(v.selectors) ? v.selectors : [];
  return {
    selectors: selectors.slice(0, 20).map((s, i) => str(s, `step.target.selectors[${i}]`, 500)),
    tag: str(v.tag, 'step.target.tag', 50),
    text: optStr(v.text, 'step.target.text', 200),
    intent: str(v.intent, 'step.target.intent', 500),
    context: optStr(v.context, 'step.target.context', 500),
    framePath: [],
  };
};

const parseCandidate = (v: unknown, i: number): Candidate => {
  if (!isObj(v)) throw new BadRequest(`candidates[${i}] must be an object`);
  const attrs: Record<string, string> = {};
  if (isObj(v.attrs)) {
    for (const [k, val] of Object.entries(v.attrs).slice(0, 20)) {
      if (typeof val === 'string') attrs[k.slice(0, 40)] = val.slice(0, 120);
    }
  }
  return {
    // The index is what the model answers with; it must be the position.
    index: i,
    tag: str(v.tag, `candidates[${i}].tag`, 50),
    text: str(v.text ?? '', `candidates[${i}].text`, 200),
    attrs,
  };
};

export const MAX_CANDIDATES = 300;

export const parseHealRequest = (body: unknown): HealRequest => {
  if (!isObj(body)) throw new BadRequest('body must be an object');
  if (!isObj(body.step)) throw new BadRequest('step must be an object');
  if (!Array.isArray(body.candidates)) throw new BadRequest('candidates must be an array');
  const page = isObj(body.page) ? body.page : {};
  return {
    step: {
      intent: str(body.step.intent, 'step.intent', 500),
      target: parseTarget(body.step.target),
    },
    candidates: body.candidates.slice(0, MAX_CANDIDATES).map(parseCandidate),
    page: {
      title: str(page.title ?? '', 'page.title', 300),
      url: str(page.url ?? '', 'page.url', 2_000),
    },
    objective: optStr(body.objective, 'objective', 1_000),
  };
};

export const renderHealPrompt = (req: HealRequest): string => {
  const candidateLines = req.candidates
    .map((c) => {
      const attrs = Object.entries(c.attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `[${c.index}] <${c.tag}${attrs ? ' ' + attrs : ''}> ${c.text || '(no text)'}`;
    })
    .join('\n');
  const t = req.step.target;
  return [
    req.objective ? `Workflow goal: ${req.objective}` : '',
    `Page: ${req.page.title} (${req.page.url})`,
    '',
    'Original step:',
    `- Intent: ${req.step.intent}`,
    `- Element: <${t.tag}> ${t.text ?? ''}`,
    `- Old selectors (all failed): ${t.selectors.join(' | ')}`,
    t.context ? `- Text near the element when recorded: ${t.context}` : '',
    '',
    'Interactive elements on the page right now:',
    candidateLines || '(none found)',
  ]
    .filter(Boolean)
    .join('\n');
};

// ---------------------------------------------------------------------------
// Agent turns
// ---------------------------------------------------------------------------

export const MAX_AGENT_MESSAGES = 80;

// The extension owns the conversation (it drives the real tab between
// turns); the server owns model, system prompt, tools and caching. So the
// client may only send user/assistant messages, and any cache_control it
// sets is dropped — the server places its own.
export const parseAgentMessages = (body: unknown): Anthropic.MessageParam[] => {
  if (!isObj(body) || !Array.isArray(body.messages)) {
    throw new BadRequest('messages must be an array');
  }
  const messages = body.messages;
  if (messages.length === 0) throw new BadRequest('messages must not be empty');
  if (messages.length > MAX_AGENT_MESSAGES) throw new BadRequest('too many messages');
  return messages.map((m, i) => {
    if (!isObj(m)) throw new BadRequest(`messages[${i}] must be an object`);
    if (m.role !== 'user' && m.role !== 'assistant') {
      throw new BadRequest(`messages[${i}].role must be user or assistant`);
    }
    if (i === 0 && m.role !== 'user') throw new BadRequest('the first message must be from the user');
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    if (!Array.isArray(m.content)) throw new BadRequest(`messages[${i}].content must be an array`);
    const content = m.content.map((b, j) => {
      if (!isObj(b) || typeof b.type !== 'string') {
        throw new BadRequest(`messages[${i}].content[${j}] must be a content block`);
      }
      const copy = { ...b };
      delete copy.cache_control;
      return copy;
    });
    // Block shapes are validated by the API itself; we only guarantee the
    // envelope here.
    return { role: m.role, content: content as unknown as Anthropic.ContentBlockParam[] };
  });
};
