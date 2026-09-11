import { describe, expect, test } from 'bun:test';
import { mergeWorkflows } from './sync';
import type { Workflow } from './types';

const wf = (id: string, updatedAt: number, name = id): Workflow => ({
  id,
  name,
  createdAt: 0,
  updatedAt,
  startUrl: 'https://x.test',
  steps: [],
  healCount: 0,
});

describe('mergeWorkflows', () => {
  test('newer side wins per id', () => {
    const r = mergeWorkflows([wf('a', 5, 'local'), wf('b', 1)], [wf('a', 3), wf('b', 9, 'remote')], new Set());
    expect(r.merged.find((w) => w.id === 'a')!.name).toBe('local');
    expect(r.merged.find((w) => w.id === 'b')!.name).toBe('remote');
    expect(r.toPush.map((w) => w.id)).toEqual(['a']);
    expect(r.changed).toBe(true);
  });

  test('local-only workflows are pushed, remote-only pulled', () => {
    const r = mergeWorkflows([wf('l', 1)], [wf('r', 1)], new Set());
    expect(r.merged.map((w) => w.id).sort()).toEqual(['l', 'r']);
    expect(r.toPush.map((w) => w.id)).toEqual(['l']);
  });

  test('a tombstoned workflow is deleted remotely, not resurrected', () => {
    const r = mergeWorkflows([], [wf('gone', 9)], new Set(['gone']));
    expect(r.merged).toEqual([]);
    expect(r.toDeleteRemote).toEqual(['gone']);
    expect(r.changed).toBe(false);
  });

  test('equal timestamps are a no-op', () => {
    const r = mergeWorkflows([wf('a', 2)], [wf('a', 2)], new Set());
    expect(r.toPush).toEqual([]);
    expect(r.changed).toBe(false);
  });
});
