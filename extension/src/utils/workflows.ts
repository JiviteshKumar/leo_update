import { createMutex } from './mutex';
import type { Settings, Workflow } from './types';
import { DEFAULT_CURSOR_COLOR, DEFAULT_SPEED } from './types';

const WORKFLOWS_KEY = 'leo:workflows';
const TOMBSTONES_KEY = 'leo:deletedWorkflows';
const SETTINGS_KEY = 'leo:settings';

// Every write is a read-modify-write of one storage key, so they go through
// one lock; otherwise a sync merge could overwrite a save that landed while
// it was running.
const lock = createMutex();

const readAll = async (): Promise<Workflow[]> => {
  const res = await browser.storage.local.get(WORKFLOWS_KEY);
  return ((res[WORKFLOWS_KEY] as Workflow[] | undefined) ?? []).slice();
};

const writeAll = (all: Workflow[]) =>
  browser.storage.local.set({ [WORKFLOWS_KEY]: all.sort((a, b) => b.updatedAt - a.updatedAt) });

export const listWorkflows = async (): Promise<Workflow[]> =>
  (await readAll()).sort((a, b) => b.updatedAt - a.updatedAt);

export const getWorkflow = async (id: string): Promise<Workflow | null> =>
  (await readAll()).find((w) => w.id === id) ?? null;

export const saveWorkflow = (workflow: Workflow): Promise<void> =>
  lock(async () => {
    const all = await readAll();
    await writeAll([workflow, ...all.filter((w) => w.id !== workflow.id)]);
  });

// Atomic read-modify-write of one workflow. `fn` returns the new version, or
// null to leave it unchanged. Resolves to the stored workflow (or null if it
// doesn't exist).
export const updateWorkflow = (
  id: string,
  fn: (wf: Workflow) => Workflow | null,
): Promise<Workflow | null> =>
  lock(async () => {
    const all = await readAll();
    const i = all.findIndex((w) => w.id === id);
    if (i < 0) return null;
    const next = fn(structuredClone(all[i]));
    if (!next) return all[i];
    all[i] = next;
    await writeAll(all);
    return next;
  });

export const deleteWorkflow = (id: string): Promise<void> =>
  lock(async () => {
    await writeAll((await readAll()).filter((w) => w.id !== id));
    const tombs = await getTombstones();
    tombs.add(id);
    await browser.storage.local.set({ [TOMBSTONES_KEY]: [...tombs] });
  });

// Sync merge, under the lock: `fn` gets the current local list and returns
// the list to store (or null for no change).
export const mergeLocal = <T>(fn: (local: Workflow[]) => { next: Workflow[] | null; result: T }): Promise<T> =>
  lock(async () => {
    const { next, result } = fn(await readAll());
    if (next) await writeAll(next);
    return result;
  });

export const getTombstones = async (): Promise<Set<string>> => {
  const res = await browser.storage.local.get(TOMBSTONES_KEY);
  return new Set((res[TOMBSTONES_KEY] as string[] | undefined) ?? []);
};

// Forget a tombstone once the cloud copy is gone.
export const clearTombstone = (id: string): Promise<void> =>
  lock(async () => {
    const tombs = await getTombstones();
    if (!tombs.delete(id)) return;
    await browser.storage.local.set({ [TOMBSTONES_KEY]: [...tombs] });
  });

export const getSettings = async (): Promise<Settings> => {
  const res = await browser.storage.local.get(SETTINGS_KEY);
  const s = (res[SETTINGS_KEY] as Partial<Settings> | undefined) ?? {};
  return {
    cursorColor: s.cursorColor ?? DEFAULT_CURSOR_COLOR,
    speed: s.speed ?? DEFAULT_SPEED,
  };
};

export const setSettings = async (settings: Settings): Promise<void> => {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
};
