import type { Candidate, TargetInfo } from './types';

// Repairing a broken step without AI.
//
// When every recorded selector fails, the live page's interactive elements
// are scored against what was recorded: identifying attributes, visible
// text, tag and surrounding text. A winner is only accepted when it scores
// well AND is clearly ahead of the runner-up — otherwise the choice is a
// guess, and the AI healer (which reads the whole page) decides instead.

export interface LocalMatch {
  index: number;
  score: number;
  // How far ahead of the runner-up. Low margin = several plausible
  // elements, so the match is not trustworthy.
  margin: number;
  // Plain-English reason, shown in the run log.
  why: string;
}

export interface MatchThresholds {
  minScore?: number;
  minMargin?: number;
}

const DEFAULTS = { minScore: 0.7, minMargin: 0.1 };

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

const words = (s: string): string[] => norm(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);

// 1 = identical, 0 = nothing in common.
export const textScore = (a?: string, b?: string): number => {
  if (!a || !b) return 0;
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.75;
  const ta = new Set(words(x));
  const tb = new Set(words(y));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
};

// The attribute values the recorded selectors were built from, e.g.
// `button[name="save"]` → { name: 'save' }. These are what identified the
// element when it was recorded, so they carry the most weight.
export const attrHints = (target: TargetInfo): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const selector of target.selectors) {
    const last = selector.split(' >>> ').pop() ?? selector;
    for (const m of last.matchAll(/\[([a-zA-Z-]+)="([^"]+)"\]/g)) {
      if (!out[m[1]]) out[m[1]] = m[2].replace(/\\(.)/g, '$1');
    }
    const id = /#((?:[\w-]|\\.)+)/.exec(last);
    if (id && !out.id) out.id = id[1].replace(/\\(.)/g, '$1');
  }
  return out;
};

// Attribute → how much a match on it is worth.
const ATTR_WEIGHTS: [string, number][] = [
  // A surviving test id is the strongest evidence there is: it outranks
  // matching text, which a redesign changes more often.
  ['data-testid', 0.8],
  ['data-test', 0.8],
  ['data-qa', 0.8],
  ['data-cy', 0.8],
  ['name', 0.5],
  ['aria-label', 0.5],
  ['placeholder', 0.45],
  ['id', 0.4],
  ['href', 0.35],
  ['title', 0.2],
  ['role', 0.1],
  ['type', 0.1],
];

export const scoreCandidate = (
  target: TargetInfo,
  hints: Record<string, string>,
  c: Candidate,
): { score: number; why: string } => {
  let score = 0;
  const why: string[] = [];

  for (const [attr, weight] of ATTR_WEIGHTS) {
    const want = hints[attr];
    const got = c.attrs[attr];
    if (want && got && norm(want) === norm(got)) {
      score += weight;
      why.push(`${attr} matches`);
    }
  }

  const text = textScore(target.text, c.text);
  if (text > 0) {
    score += 0.6 * text;
    why.push(text === 1 ? 'same text' : 'similar text');
  } else if (!target.text) {
    // Fields carry no visible text; the recorded intent holds their label
    // ('Type into the "Email" field').
    const quoted = /"([^"]+)"/.exec(target.intent)?.[1];
    const label = textScore(quoted, c.text || c.attrs['aria-label'] || c.attrs.placeholder);
    if (label > 0) {
      score += 0.55 * label;
      why.push(label === 1 ? 'same label' : 'similar label');
    }
  }

  const clickable = (tag: string, attrs: Record<string, string>) =>
    ['a', 'button', 'input', 'summary'].includes(tag) || attrs.role === 'button' || attrs.role === 'link';
  if (c.tag === target.tag) {
    score += 0.15;
    why.push('same kind of element');
  } else if (clickable(c.tag, c.attrs) && clickable(target.tag, {})) {
    // A redesign that turns a <button> into an <a> keeps the control.
    why.push('still a control');
  } else {
    score -= 0.12;
  }

  if (target.context && c.context) {
    const around = textScore(target.context, c.context);
    if (around > 0.3) {
      score += 0.15 * around;
      why.push('same surroundings');
    }
  }

  return { score: Math.max(0, Math.min(1, score)), why: why.join(', ') };
};

// The element to repair the step with, or null when no candidate is a clear
// enough winner (the AI healer then decides).
export const bestLocalMatch = (
  target: TargetInfo,
  candidates: Candidate[],
  thresholds: MatchThresholds = {},
): LocalMatch | null => {
  if (!candidates.length) return null;
  const { minScore, minMargin } = { ...DEFAULTS, ...thresholds };
  const hints = attrHints(target);
  const scored = candidates
    .map((c) => ({ index: c.index, ...scoreCandidate(target, hints, c) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1]?.score ?? 0;
  const margin = best.score - runnerUp;
  if (best.score < minScore || margin < minMargin) return null;
  const round = (n: number) => Math.round(n * 100) / 100;
  return { index: best.index, score: round(best.score), margin: round(margin), why: best.why };
};
