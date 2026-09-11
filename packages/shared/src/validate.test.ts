import { describe, expect, test } from 'bun:test';
import { validateSteps, validateWorkflow } from './validate';

const target = { selectors: ['#go'], tag: 'button', intent: 'Click "Go"', framePath: [] };

const wf = (over: Record<string, unknown> = {}) => ({
  id: 'abc',
  name: 'Test',
  createdAt: 1,
  updatedAt: 2,
  startUrl: 'https://example.com',
  healCount: 0,
  steps: [{ type: 'navigate', url: 'https://example.com' }, { type: 'click', target }],
  ...over,
});

describe('validateWorkflow', () => {
  test('accepts a well-formed workflow', () => {
    const r = validateWorkflow(wf({ objective: 'Do the thing' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.steps).toHaveLength(2);
      expect(r.value.objective).toBe('Do the thing');
    }
  });

  test('strips unknown fields', () => {
    const r = validateWorkflow(wf({ evil: 'x', steps: [{ type: 'download', extra: 1 }] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('evil' in r.value).toBe(false);
      expect(r.value.steps[0]).toEqual({ type: 'download' });
    }
  });

  test('never keeps secret text', () => {
    const r = validateSteps([{ type: 'type', target, text: 'hunter2', secret: true }]);
    expect(r.ok && r.value[0].type === 'type' && r.value[0].text).toBe('');
  });

  test('rejects unknown step types with a path', () => {
    const r = validateWorkflow(wf({ steps: [{ type: 'teleport' }] }));
    expect(r).toEqual({ ok: false, error: 'steps[0].type "teleport" is not a known step type' });
  });

  test('rejects blank agent goals', () => {
    const r = validateSteps([{ type: 'agent', goal: '   ' }]);
    expect(r.ok).toBe(false);
  });

  test('rejects non-numeric timestamps', () => {
    expect(validateWorkflow(wf({ updatedAt: 'now' })).ok).toBe(false);
  });

  test('defaults a missing framePath to the top frame', () => {
    const { framePath: _omit, ...rest } = target;
    const r = validateSteps([{ type: 'click', target: rest }]);
    expect(r.ok && r.value[0].type === 'click' && r.value[0].target.framePath).toEqual([]);
  });

  test('accepts upload and tab steps', () => {
    const r = validateSteps([
      { type: 'upload', target },
      { type: 'switch-tab', urlHint: 'https://x.test/popup' },
      { type: 'switch-tab' },
      { type: 'close-tab' },
    ]);
    expect(r.ok && r.value.map((s) => s.type)).toEqual(['upload', 'switch-tab', 'switch-tab', 'close-tab']);
    expect(r.ok && r.value[2]).toEqual({ type: 'switch-tab', urlHint: '' });
  });

  test('accepts drag steps and clamps positions into the box', () => {
    const r = validateSteps([{ type: 'drag', from: target, to: target, fromPos: { x: 0.2, y: 0.5 }, toPos: { x: 1.4, y: -1 } }]);
    expect(r.ok && r.value[0]).toMatchObject({ type: 'drag', fromPos: { x: 0.2, y: 0.5 }, toPos: { x: 1, y: 0 } });
    expect(validateSteps([{ type: 'drag', from: target }]).ok).toBe(false);
  });

  test('keeps key modifiers and drops false ones', () => {
    const r = validateSteps([{ type: 'key', key: 'k', mods: { ctrl: true, shift: false } }]);
    expect(r.ok && r.value[0]).toEqual({ type: 'key', key: 'k', mods: { ctrl: true } });
  });
});
