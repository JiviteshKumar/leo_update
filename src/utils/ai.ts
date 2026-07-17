import Anthropic from '@anthropic-ai/sdk';
import type { Candidate, Settings, TargetInfo } from './types';

// AI self-healing: when every recorded selector fails, ask Claude to match
// the step's intent against the live page's interactive elements. Structured
// outputs guarantee a parseable verdict. Runs in the extension service
// worker with the user's own API key, hence dangerouslyAllowBrowser.

export interface HealVerdict {
  match: number | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

const VERDICT_SCHEMA = {
  type: 'object' as const,
  properties: {
    match: {
      type: ['integer', 'null'],
      description:
        'Index of the candidate element that is the same control the user originally interacted with, or null if none matches.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'One short sentence.' },
  },
  required: ['match', 'confidence', 'reason'],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  'You repair broken browser automations. A recorded workflow step can no ' +
  'longer find its target element because the website changed. You are given ' +
  'the original step (intent, element tag, visible text, old selectors, ' +
  'nearby text) and a numbered list of interactive elements currently ' +
  'visible on the page. Pick the candidate that is the SAME control the ' +
  'user originally interacted with. Match on purpose and meaning, not on ' +
  'exact attribute equality. If no candidate plausibly serves the same ' +
  'purpose, return null rather than guessing.';

export const healStep = async (
  settings: Settings,
  step: { intent: string; target: TargetInfo },
  candidates: Candidate[],
  page: { title: string; url: string },
): Promise<HealVerdict> => {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    dangerouslyAllowBrowser: true,
  });

  const candidateLines = candidates
    .map((c) => {
      const attrs = Object.entries(c.attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `[${c.index}] <${c.tag}${attrs ? ' ' + attrs : ''}> ${c.text || '(no text)'}`;
    })
    .join('\n');

  const user = [
    `Page: ${page.title} (${page.url})`,
    '',
    'Original step:',
    `- Intent: ${step.intent}`,
    `- Element: <${step.target.tag}> ${step.target.text ?? ''}`,
    `- Old selectors (all failed): ${step.target.selectors.join(' | ')}`,
    step.target.context ? `- Text near the element when recorded: ${step.target.context}` : '',
    '',
    'Interactive elements on the page right now:',
    candidateLines || '(none found)',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: {
      format: {
        type: 'json_schema',
        schema: VERDICT_SCHEMA,
      },
    },
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') {
    return { match: null, confidence: 'low', reason: 'model declined the request' };
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const verdict = JSON.parse(text) as HealVerdict;
  if (verdict.match != null && (verdict.match < 0 || verdict.match >= candidates.length)) {
    return { match: null, confidence: 'low', reason: 'model returned an invalid index' };
  }
  return verdict;
};

export const describeAiError = (err: unknown): string => {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic API key was rejected. Check it in Settings.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Anthropic API rate limit hit. Try again in a minute.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
};
