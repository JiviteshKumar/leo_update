import type { Workflow } from './types';

// Pure merge for cloud sync: last-write-wins per workflow UUID, with
// tombstones so a workflow deleted locally (possibly while offline) is
// deleted remotely instead of coming back from the cloud copy.

export interface MergeResult {
  merged: Workflow[];
  // Local copies that are newer than (or missing from) the cloud.
  toPush: Workflow[];
  // Deleted locally; remove from the cloud.
  toDeleteRemote: string[];
  changed: boolean;
}

export const mergeWorkflows = (
  local: Workflow[],
  remote: Workflow[],
  tombstones: ReadonlySet<string>,
): MergeResult => {
  const localById = new Map(local.map((w) => [w.id, w]));
  const merged = new Map(localById);
  const toPush: Workflow[] = [];
  const toDeleteRemote: string[] = [];
  let changed = false;

  for (const r of remote) {
    if (tombstones.has(r.id)) {
      toDeleteRemote.push(r.id);
      continue;
    }
    const l = localById.get(r.id);
    if (!l || r.updatedAt > l.updatedAt) {
      merged.set(r.id, r);
      changed = true;
    } else if (l.updatedAt > r.updatedAt) {
      toPush.push(l);
    }
  }
  const remoteIds = new Set(remote.map((w) => w.id));
  for (const l of local) if (!remoteIds.has(l.id)) toPush.push(l);

  return {
    merged: [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    toPush,
    toDeleteRemote,
    changed,
  };
};
