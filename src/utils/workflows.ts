import type { Settings, Workflow } from './types';
import { DEFAULT_CURSOR_COLOR, DEFAULT_MODEL, DEFAULT_SPEED } from './types';

const WORKFLOWS_KEY = 'leo:workflows';
const SETTINGS_KEY = 'leo:settings';

export const listWorkflows = async (): Promise<Workflow[]> => {
  const res = await browser.storage.local.get(WORKFLOWS_KEY);
  const all = (res[WORKFLOWS_KEY] as Workflow[] | undefined) ?? [];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
};

export const getWorkflow = async (id: string): Promise<Workflow | null> =>
  (await listWorkflows()).find((w) => w.id === id) ?? null;

export const saveWorkflow = async (workflow: Workflow): Promise<void> => {
  const all = await listWorkflows();
  const next = [workflow, ...all.filter((w) => w.id !== workflow.id)];
  await browser.storage.local.set({ [WORKFLOWS_KEY]: next });
};

export const deleteWorkflow = async (id: string): Promise<void> => {
  const all = await listWorkflows();
  await browser.storage.local.set({
    [WORKFLOWS_KEY]: all.filter((w) => w.id !== id),
  });
};

export const getSettings = async (): Promise<Settings> => {
  const res = await browser.storage.local.get(SETTINGS_KEY);
  const s = (res[SETTINGS_KEY] as Partial<Settings> | undefined) ?? {};
  return {
    apiKey: s.apiKey ?? '',
    model: s.model ?? DEFAULT_MODEL,
    cursorColor: s.cursorColor ?? DEFAULT_CURSOR_COLOR,
    speed: s.speed ?? DEFAULT_SPEED,
  };
};

export const setSettings = async (settings: Settings): Promise<void> => {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
};
