import { describe, expect, test } from 'bun:test';
import { BadRequest, parseAgentMessages, parseHealRequest, renderHealPrompt } from './requests';

const heal = {
  step: {
    intent: 'Click "Save"',
    target: { selectors: ['#save'], tag: 'button', intent: 'Click "Save"', text: 'Save', framePath: [] },
  },
  candidates: [
    { index: 7, tag: 'button', text: 'Save changes', attrs: { id: 'save-v2', onclick: 1 } },
    { index: 9, tag: 'a', text: 'Cancel', attrs: {} },
  ],
  page: { title: 'Settings', url: 'https://x.test/settings' },
};

describe('parseHealRequest', () => {
  test('re-indexes candidates by position and drops non-string attrs', () => {
    const r = parseHealRequest(heal);
    expect(r.candidates.map((c) => c.index)).toEqual([0, 1]);
    expect(r.candidates[0].attrs).toEqual({ id: 'save-v2' });
  });

  test('rejects a missing step', () => {
    expect(() => parseHealRequest({ candidates: [] })).toThrow(BadRequest);
  });

  test('renders every candidate and the failed selectors', () => {
    const prompt = renderHealPrompt(parseHealRequest(heal));
    expect(prompt).toContain('[0] <button id="save-v2"> Save changes');
    expect(prompt).toContain('Old selectors (all failed): #save');
  });
});

describe('parseAgentMessages', () => {
  test('strips client cache_control', () => {
    const msgs = parseAgentMessages({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
      ],
    });
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  test('rejects system roles and assistant-first conversations', () => {
    expect(() => parseAgentMessages({ messages: [{ role: 'system', content: 'x' }] })).toThrow(BadRequest);
    expect(() => parseAgentMessages({ messages: [{ role: 'assistant', content: 'x' }] })).toThrow(BadRequest);
  });

  test('rejects empty and oversized histories', () => {
    expect(() => parseAgentMessages({ messages: [] })).toThrow(BadRequest);
    const many = Array.from({ length: 81 }, () => ({ role: 'user', content: 'x' }));
    expect(() => parseAgentMessages({ messages: many })).toThrow(BadRequest);
  });
});
