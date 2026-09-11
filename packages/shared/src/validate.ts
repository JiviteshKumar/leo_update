import type { DragStep, KeyMods, KeyStep, RelPoint, Step, TargetInfo, Workflow } from './types';

// Structural validation for workflows crossing a trust boundary (the web
// app's sync API, imports). Returns a normalized copy containing only known
// fields, so junk properties never reach storage.

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const LIMITS = {
  steps: 2_000,
  selectors: 20,
  string: 20_000,
};

class Invalid extends Error {}

const fail = (msg: string): never => {
  throw new Invalid(msg);
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown, path: string, opts: { allowEmpty?: boolean } = {}): string => {
  if (typeof v !== 'string') return fail(`${path} must be a string`);
  if (!opts.allowEmpty && v.length === 0) return fail(`${path} must not be empty`);
  if (v.length > LIMITS.string) return fail(`${path} is too long`);
  return v;
};

const optStr = (v: unknown, path: string): string | undefined =>
  v === undefined || v === null ? undefined : str(v, path, { allowEmpty: true });

const num = (v: unknown, path: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${path} must be a finite number`);
  return v;
};

const bool = (v: unknown, path: string): boolean => {
  if (typeof v !== 'boolean') return fail(`${path} must be a boolean`);
  return v;
};

const target = (v: unknown, path: string): TargetInfo => {
  if (!isObj(v)) return fail(`${path} must be an object`);
  if (!Array.isArray(v.selectors)) return fail(`${path}.selectors must be an array`);
  if (v.selectors.length > LIMITS.selectors) return fail(`${path}.selectors has too many entries`);
  const framePath = v.framePath === undefined ? [] : v.framePath;
  if (!Array.isArray(framePath)) return fail(`${path}.framePath must be an array`);
  const t: TargetInfo = {
    selectors: v.selectors.map((s, i) => str(s, `${path}.selectors[${i}]`)),
    tag: str(v.tag, `${path}.tag`),
    intent: str(v.intent, `${path}.intent`),
    framePath: framePath.map((s, i) => str(s, `${path}.framePath[${i}]`)),
  };
  const text = optStr(v.text, `${path}.text`);
  if (text !== undefined) t.text = text;
  const context = optStr(v.context, `${path}.context`);
  if (context !== undefined) t.context = context;
  return t;
};

const relPoint = (v: unknown, path: string): RelPoint | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) return fail(`${path} must be an object`);
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return { x: clamp(num(v.x, `${path}.x`)), y: clamp(num(v.y, `${path}.y`)) };
};

const mods = (v: unknown, path: string): KeyMods | undefined => {
  if (v === undefined) return undefined;
  if (!isObj(v)) return fail(`${path} must be an object`);
  const m: KeyMods = {};
  for (const k of ['ctrl', 'meta', 'alt', 'shift'] as const) {
    if (v[k] !== undefined && bool(v[k], `${path}.${k}`)) m[k] = true;
  }
  return Object.keys(m).length ? m : undefined;
};

export const parseStep = (v: unknown, path = 'step'): Step => {
  if (!isObj(v)) return fail(`${path} must be an object`);
  switch (v.type) {
    case 'navigate':
      return { type: 'navigate', url: str(v.url, `${path}.url`) };
    case 'nav-wait':
      return { type: 'nav-wait', urlHint: str(v.urlHint, `${path}.urlHint`, { allowEmpty: true }) };
    case 'click':
    case 'dblclick':
      return { type: v.type, target: target(v.target, `${path}.target`) };
    case 'type': {
      const secret = bool(v.secret, `${path}.secret`);
      return {
        type: 'type',
        target: target(v.target, `${path}.target`),
        // Secrets are never stored, even if a client sends one.
        text: secret ? '' : str(v.text, `${path}.text`, { allowEmpty: true }),
        secret,
      };
    }
    case 'select':
      return {
        type: 'select',
        target: target(v.target, `${path}.target`),
        value: str(v.value, `${path}.value`, { allowEmpty: true }),
        label: str(v.label, `${path}.label`, { allowEmpty: true }),
      };
    case 'key': {
      const step: KeyStep = { type: 'key', key: str(v.key, `${path}.key`) };
      const m = mods(v.mods, `${path}.mods`);
      if (m) step.mods = m;
      if (v.target !== undefined && v.target !== null) step.target = target(v.target, `${path}.target`);
      return step;
    }
    case 'download':
      return { type: 'download' };
    case 'upload':
      return { type: 'upload', target: target(v.target, `${path}.target`) };
    case 'switch-tab':
      return { type: 'switch-tab', urlHint: str(v.urlHint ?? '', `${path}.urlHint`, { allowEmpty: true }) };
    case 'close-tab':
      return { type: 'close-tab' };
    case 'drag': {
      const step: DragStep = {
        type: 'drag',
        from: target(v.from, `${path}.from`),
        to: target(v.to, `${path}.to`),
      };
      const fromPos = relPoint(v.fromPos, `${path}.fromPos`);
      const toPos = relPoint(v.toPos, `${path}.toPos`);
      if (fromPos) step.fromPos = fromPos;
      if (toPos) step.toPos = toPos;
      return step;
    }
    case 'agent':
      return { type: 'agent', goal: str(v.goal, `${path}.goal`).trim() || fail(`${path}.goal must not be blank`) };
    default:
      return fail(`${path}.type "${String(v.type)}" is not a known step type`);
  }
};

export const validateSteps = (v: unknown): Validated<Step[]> => {
  try {
    if (!Array.isArray(v)) return { ok: false, error: 'steps must be an array' };
    if (v.length > LIMITS.steps) return { ok: false, error: 'workflow has too many steps' };
    return { ok: true, value: v.map((s, i) => parseStep(s, `steps[${i}]`)) };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
};

export const validateWorkflow = (v: unknown): Validated<Workflow> => {
  try {
    if (!isObj(v)) return { ok: false, error: 'workflow must be an object' };
    const steps = validateSteps(v.steps);
    if (!steps.ok) return steps;
    const healCount = num(v.healCount ?? 0, 'healCount');
    const wf: Workflow = {
      id: str(v.id, 'id'),
      name: str(v.name, 'name'),
      createdAt: num(v.createdAt, 'createdAt'),
      updatedAt: num(v.updatedAt, 'updatedAt'),
      startUrl: str(v.startUrl, 'startUrl', { allowEmpty: true }),
      steps: steps.value,
      healCount: Math.max(0, Math.floor(healCount)),
    };
    if (wf.id.length > 100) return { ok: false, error: 'id is too long' };
    const objective = optStr(v.objective, 'objective');
    if (objective) wf.objective = objective;
    return { ok: true, value: wf };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
};
