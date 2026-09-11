import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { fromOpenAiMessage, toOpenAiMessages, toOpenAiTools } from './openai-format';

const conversation = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'This step: pick Team' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: '[0] <button> Choose a plan' },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: 'x' },
      { type: 'text', text: 'Opening the dropdown.' },
      { type: 'tool_use', id: 'call_1', name: 'click', input: { index: 0 } },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
          { type: 'text', text: 'Last action: done\n[3] <li> Team' },
        ],
      },
    ],
  },
] as unknown as Anthropic.MessageParam[];

describe('toOpenAiMessages', () => {
  const out = toOpenAiMessages('SYSTEM', conversation);

  test('system first, images dropped, text kept', () => {
    expect(out[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(out[1]).toEqual({ role: 'user', content: 'This step: pick Team\n\n[0] <button> Choose a plan' });
  });

  test('tool_use becomes tool_calls and thinking is dropped', () => {
    expect(out[2]).toEqual({
      role: 'assistant',
      content: 'Opening the dropdown.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'click', arguments: '{"index":0}' } }],
    });
  });

  test('tool_result becomes a tool message right after the call', () => {
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Last action: done\n[3] <li> Team' });
    expect(out).toHaveLength(4);
  });

  test('errors are flagged in tool results', () => {
    const err = toOpenAiMessages('S', [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'click', input: { index: 9 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', is_error: true, content: 'failed: gone' }] },
    ] as unknown as Anthropic.MessageParam[]);
    expect(err[3]).toEqual({ role: 'tool', tool_call_id: 'c', content: 'ERROR: failed: gone' });
  });
});

describe('toOpenAiMessages compact', () => {
  const twoTurns = [
    ...conversation,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'click', input: { index: 3 } }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'Last action: done\nPage: Plans (x)\n[5] <button> Done' }],
    },
  ] as unknown as Anthropic.MessageParam[];
  const out = toOpenAiMessages('S', twoTurns, { compact: true });

  test('keeps the goal but drops the first observation once stale', () => {
    expect(out[1]).toEqual({ role: 'user', content: 'This step: pick Team' });
  });

  test('older tool results shrink to their summary lines', () => {
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Last action: done' });
  });

  test('the newest observation is kept in full', () => {
    expect(out[5]).toEqual({
      role: 'tool',
      tool_call_id: 'call_2',
      content: 'Last action: done\nPage: Plans (x)\n[5] <button> Done',
    });
  });

  test('a single-turn conversation is unchanged', () => {
    expect(toOpenAiMessages('S', conversation.slice(0, 1), { compact: true })).toEqual(
      toOpenAiMessages('S', conversation.slice(0, 1)),
    );
  });
});

describe('fromOpenAiMessage', () => {
  test('tool calls become tool_use blocks with parsed input', () => {
    const r = fromOpenAiMessage({
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'type', arguments: '{"index":2,"text":"hi"}' } }],
    });
    expect(r.stop_reason).toBe('tool_use');
    expect(r.content).toEqual([{ type: 'tool_use', id: 't1', name: 'type', input: { index: 2, text: 'hi' } }] as never);
  });

  test('malformed arguments do not throw', () => {
    const r = fromOpenAiMessage({ tool_calls: [{ id: 't', type: 'function', function: { name: 'click', arguments: '{bad' } }] });
    expect(r.content).toEqual([{ type: 'tool_use', id: 't', name: 'click', input: {} }] as never);
  });

  test('plain text ends the turn', () => {
    expect(fromOpenAiMessage({ content: 'All done.' })).toEqual({
      content: [{ type: 'text', text: 'All done.' }] as never,
      stop_reason: 'end_turn',
    });
  });
});

test('tools map to function definitions', () => {
  const tools = toOpenAiTools([
    { name: 'click', description: 'Click', input_schema: { type: 'object', properties: { index: { type: 'integer' } } } },
  ]);
  expect(tools[0]).toEqual({
    type: 'function',
    function: { name: 'click', description: 'Click', parameters: { type: 'object', properties: { index: { type: 'integer' } } } },
  });
});
