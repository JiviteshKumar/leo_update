import { describe, expect, test } from 'bun:test';
import { attrHints, bestLocalMatch, textScore } from './match';
import type { Candidate, TargetInfo } from './types';

const target = (over: Partial<TargetInfo> = {}): TargetInfo => ({
  selectors: ['#save-btn', 'button[name="save"]'],
  tag: 'button',
  text: 'Save changes',
  intent: 'Click "Save changes"',
  context: 'Profile settings Save changes Cancel',
  framePath: [],
  ...over,
});

const candidate = (index: number, over: Partial<Candidate> = {}): Candidate => ({
  index,
  tag: 'button',
  text: '',
  attrs: {},
  ...over,
});

describe('textScore', () => {
  test('rewards identical, contained and overlapping text', () => {
    expect(textScore('Save', 'save')).toBe(1);
    expect(textScore('Save', 'Save draft')).toBe(0.75);
    expect(textScore('Download monthly invoice', 'Monthly invoice export')).toBeGreaterThan(0.3);
    expect(textScore('Save', 'Cancel')).toBe(0);
  });
});

test('attrHints reads the attributes the selectors were built from', () => {
  expect(attrHints(target())).toEqual({ id: 'save-btn', name: 'save' });
  expect(attrHints(target({ selectors: ['app-shell >>> button[data-testid="go"]'] }))).toEqual({
    'data-testid': 'go',
  });
});

describe('bestLocalMatch', () => {
  test('matches after a redesign renamed the id, on text alone', () => {
    const m = bestLocalMatch(target(), [
      candidate(0, { text: 'Cancel' }),
      candidate(1, { text: 'Save changes', attrs: { id: 'btn-a1b2c3' } }),
    ]);
    expect(m?.index).toBe(1);
    expect(m?.why).toContain('same text');
  });

  test('a surviving test id wins even when the text changed', () => {
    const m = bestLocalMatch(target({ selectors: ['button[data-testid="save"]'] }), [
      candidate(0, { text: 'Save changes', attrs: { 'data-testid': 'save-draft' } }),
      candidate(1, { text: 'Apply', attrs: { 'data-testid': 'save' } }),
    ]);
    expect(m?.index).toBe(1);
  });

  test('refuses when two candidates are equally plausible', () => {
    const m = bestLocalMatch(target(), [
      candidate(0, { text: 'Save changes' }),
      candidate(1, { text: 'Save changes' }),
    ]);
    expect(m).toBeNull();
  });

  test('refuses when nothing resembles the recorded element', () => {
    expect(bestLocalMatch(target(), [candidate(0, { text: 'Log out', tag: 'a' })])).toBeNull();
    expect(bestLocalMatch(target(), [])).toBeNull();
  });

  test('a form field is matched by its label from the recorded intent', () => {
    const field = target({
      selectors: ['#email'],
      tag: 'input',
      text: undefined,
      intent: 'Type into the "Email" field',
      context: undefined,
    });
    const m = bestLocalMatch(field, [
      candidate(0, { tag: 'input', text: 'Full name', attrs: { placeholder: 'Full name' } }),
      candidate(1, { tag: 'input', text: 'Email', attrs: { placeholder: 'Email' } }),
    ]);
    expect(m?.index).toBe(1);
  });

  test('prefers the element in the same part of the page', () => {
    const m = bestLocalMatch(target({ text: 'Delete' }), [
      candidate(0, { text: 'Delete', context: 'Danger zone Delete account' }),
      candidate(1, { text: 'Delete', context: 'Profile settings Delete changes Cancel' }),
    ]);
    expect(m?.index).toBe(1);
  });

  test('thresholds can be tightened', () => {
    const candidates = [candidate(0, { text: 'Cancel' }), candidate(1, { text: 'Save changes' })];
    expect(bestLocalMatch(target(), candidates)).not.toBeNull();
    expect(bestLocalMatch(target(), candidates, { minScore: 0.95 })).toBeNull();
  });
});
