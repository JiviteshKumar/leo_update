import { describe, expect, test } from 'bun:test';
import { describeStep, keyCombo, recoveryGoal, selectorsFromRecovery } from './describe';

const target = { selectors: ['#go'], tag: 'button', intent: 'Click "Go"', framePath: [] };

describe('describeStep', () => {
  test('hides secret text', () => {
    expect(describeStep({ type: 'type', target, text: '', secret: true })).toContain('typed by you');
  });
  test('truncates long typed text', () => {
    const s = describeStep({ type: 'type', target, text: 'x'.repeat(100), secret: false });
    expect(s.endsWith('…"')).toBe(true);
  });
  test('formats key combos', () => {
    expect(keyCombo('k', { ctrl: true, shift: true })).toBe('Ctrl+Shift+K');
    expect(keyCombo(' ')).toBe('Space');
    expect(describeStep({ type: 'key', key: 'Enter' })).toBe('Press Enter');
  });
});

describe('recovery helpers', () => {
  test('recoveryGoal includes text to type, never secrets', () => {
    expect(recoveryGoal({ type: 'type', target, text: 'hello', secret: false })).toContain('"hello"');
    expect(recoveryGoal({ type: 'type', target, text: 'pw', secret: true })).not.toContain('pw"');
  });

  test('selectorsFromRecovery only trusts a single element action', () => {
    const one = [{ action: { kind: 'click' as const, index: 1 }, healedSelectors: ['#a'] }];
    expect(selectorsFromRecovery(one)).toEqual(['#a']);
    const withScroll = [{ action: { kind: 'scroll' as const, dy: 100 } }, ...one];
    expect(selectorsFromRecovery(withScroll)).toEqual(['#a']);
    const two = [...one, { action: { kind: 'click' as const, index: 2 }, healedSelectors: ['#b'] }];
    expect(selectorsFromRecovery(two)).toBeNull();
    expect(selectorsFromRecovery([])).toBeNull();
  });
});
