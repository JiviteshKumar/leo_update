import type { AgentAction, KeyMods, Step, TargetInfo } from './types';

// Human-readable one-liner for a step. Used by the panel's step lists and as
// the input to AI objective derivation, so both read the workflow the same way.
export const describeStep = (step: Step): string => {
  switch (step.type) {
    case 'navigate':
      return `Go to ${step.url}`;
    case 'nav-wait':
      return 'Wait for the page to load';
    case 'click':
      return step.target.intent;
    case 'dblclick':
      return `Double ${lowerFirst(step.target.intent)}`;
    case 'type':
      return step.secret
        ? `${step.target.intent} (typed by you at run time)`
        : `${step.target.intent}: "${truncate(step.text, 40)}"`;
    case 'select':
      return `${step.target.intent}: ${step.label}`;
    case 'key':
      return `Press ${keyCombo(step.key, step.mods)}`;
    case 'download':
      return 'Wait for the file download';
    case 'upload':
      return `${step.target.intent} (you choose the file at run time)`;
    case 'switch-tab':
      return 'Continue in the new tab';
    case 'close-tab':
      return 'Return to the previous tab';
    case 'drag':
      return `Drag ${targetName(step.from)} onto ${targetName(step.to)}`;
    case 'agent':
      return `AI: ${step.goal}`;
  }
};

export const keyCombo = (key: string, mods?: KeyMods): string => {
  const parts: string[] = [];
  if (mods?.ctrl) parts.push('Ctrl');
  if (mods?.meta) parts.push('Cmd');
  if (mods?.alt) parts.push('Alt');
  if (mods?.shift) parts.push('Shift');
  parts.push(key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
};

export const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

const lowerFirst = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);

const targetName = (t: TargetInfo): string => (t.text ? `"${truncate(t.text, 30)}"` : `the ${t.tag}`);

// ---------------------------------------------------------------------------
// Agent recovery helpers (pure, so they're unit-tested)
// ---------------------------------------------------------------------------

// Goal text for vision-agent recovery of one failed recorded step.
export const recoveryGoal = (step: {
  type: string;
  target: TargetInfo;
  text?: string;
  secret?: boolean;
}): string =>
  `Complete this single action from a recorded browser workflow, then finish: ` +
  `${step.target.intent}.` +
  (step.target.text ? ` The original element's text was "${step.target.text}".` : '') +
  (step.target.context ? ` Text near it when recorded: "${step.target.context.slice(0, 150)}".` : '') +
  (step.type === 'type' && !step.secret && step.text ? ` Text to type: "${step.text}".` : '');

// A successfully executed agent action, with fresh selectors for the element
// it touched (when it touched one) so recovered workflow steps can be
// repaired in storage.
export interface PerformedAction {
  action: AgentAction;
  healedSelectors?: string[];
}

// Selectors to repair a recovered step with, or null when repair would be
// unsafe. Only a recovery that took exactly ONE element action is
// unambiguous: that element must be the control the step pointed at. A
// multi-action recovery (open dropdown → click option) can't be captured in
// one step's selectors — patching the last element would make the next run
// skip the earlier actions and break again. Scrolls don't touch elements and
// are ignored.
export const selectorsFromRecovery = (performed: PerformedAction[]): string[] | null => {
  const elementActions = performed.filter((p) => p.action.kind !== 'scroll');
  if (elementActions.length !== 1) return null;
  const sels = elementActions[0].healedSelectors;
  return sels && sels.length ? sels : null;
};
