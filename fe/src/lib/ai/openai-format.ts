import type Anthropic from '@anthropic-ai/sdk';

// Conversion between the Anthropic Messages shape (what the extension's agent
// loop speaks) and the OpenAI chat-completions shape (Groq and other
// OpenAI-compatible providers). Pure, so it's unit-tested.

export interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OaiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OaiTool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

type Block = { type?: string; [k: string]: unknown };

const blocksOf = (content: Anthropic.MessageParam['content']): Block[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : (content as unknown as Block[]);

// Text of a content value (string or blocks). Images are dropped: the
// OpenAI-compatible models used here are text-only.
export const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .map((b) => (b?.type === 'text' ? String(b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
};

// An older page observation, cut down to what still matters later in the
// conversation: what the action did and where it landed.
const summarizeObservation = (text: string): string => {
  const kept = text
    .split('\n')
    .filter((l) => l.startsWith('Last action:') || l.startsWith('Page:'))
    .join('\n');
  return kept || '(earlier page state omitted)';
};

// `compact`: keep full page observations only in the newest user turn. Text
// models can't use stale element lists (indexes change after every action),
// and dropping them keeps each request small for token-per-minute limits.
export const toOpenAiMessages = (
  system: string,
  messages: Anthropic.MessageParam[],
  opts: { compact?: boolean } = {},
): OaiMessage[] => {
  const out: OaiMessage[] = [{ role: 'system', content: system }];
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  for (const [idx, m] of messages.entries()) {
    const blocks = blocksOf(m.content);
    const stale = Boolean(opts.compact) && idx !== lastUser;
    if (m.role === 'assistant') {
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n');
      const calls: OaiToolCall[] = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: String(b.id),
          type: 'function',
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results become `tool` messages (they must directly
    // follow the assistant message that called them); anything else is
    // plain user text.
    const text: string[] = [];
    let textBlocks = 0;
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const full = textOf(b.content);
        const result = stale ? summarizeObservation(full) : full;
        out.push({
          role: 'tool',
          tool_call_id: String(b.tool_use_id),
          content: (b.is_error ? 'ERROR: ' : '') + (result || '(no output)'),
        });
      } else if (b.type === 'text') {
        // The opening turn is the goal followed by the first observation;
        // once stale, only the goal is kept.
        if (stale && textBlocks > 0) continue;
        textBlocks++;
        text.push(String(b.text ?? ''));
      }
    }
    if (text.length) out.push({ role: 'user', content: text.join('\n\n') });
  }
  return out;
};

export const toOpenAiTools = (tools: Anthropic.Tool[]): OaiTool[] =>
  tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

const parseArgs = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

// An OpenAI assistant message back in Anthropic content-block form.
export const fromOpenAiMessage = (msg: {
  content?: string | null;
  tool_calls?: OaiToolCall[] | null;
}): { content: Anthropic.ContentBlock[]; stop_reason: 'tool_use' | 'end_turn' } => {
  const blocks: Block[] = [];
  if (msg.content && msg.content.trim()) blocks.push({ type: 'text', text: msg.content });
  for (const call of msg.tool_calls ?? []) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
  }
  return {
    content: blocks as unknown as Anthropic.ContentBlock[],
    stop_reason: msg.tool_calls?.length ? 'tool_use' : 'end_turn',
  };
};
