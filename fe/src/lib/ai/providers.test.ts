import { expect, test } from 'bun:test';
import { afterMalformedOutput, retryDelayMs } from './providers';

test('429 waits follow Retry-After, then the message, then a default', () => {
  expect(retryDelayMs(new Headers({ 'retry-after': '3' }), '')).toBe(3_250);
  expect(retryDelayMs(new Headers(), 'Please try again in 14.1525s. Need more tokens?')).toBe(14_403);
  expect(retryDelayMs(new Headers(), 'Please try again in 1m2.5s')).toBe(62_750);
  expect(retryDelayMs(new Headers(), 'slow down')).toBe(5_000);
});

const toolBody = () => ({
  messages: [{ role: 'user', content: 'do it' }],
  tools: [{ function: { name: 'click' } }, { function: { name: 'finish' } }],
  reasoning_effort: 'medium',
});

test('a retry after an invented tool call reminds the model which tools exist', () => {
  const detail = "attempted to call tool 'commentary' which was not in request.tools";
  const next = afterMalformedOutput(toolBody(), detail) as {
    messages: { role: string; content: string }[];
    reasoning_effort: string;
  };
  expect(next.messages).toHaveLength(2);
  const note = next.messages[1];
  expect(note.role).toBe('system');
  expect(note.content).toContain('click, finish');
  expect(note.content).toContain('no "commentary" tool');
  expect(next.reasoning_effort).toBe('low');

  // The reminder is added once, however many times the retry loop runs.
  expect((afterMalformedOutput(next, detail) as { messages: unknown[] }).messages).toHaveLength(2);
});

test('requests without tools still ask for less reasoning', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium' };
  const next = afterMalformedOutput(body, 'output_parse_failed') as Record<string, unknown>;
  expect(next.messages).toBe(body.messages);
  expect(next.reasoning_effort).toBe('low');
});
