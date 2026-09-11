import type { HealVerdict } from '@leo/shared';
import { AI_MAX_TOKENS, AI_MODEL, aiRoute, firstText } from '@/lib/ai/anthropic';
import { parseHealRequest, renderHealPrompt } from '@/lib/ai/requests';

// AI self-healing: when every recorded selector fails, match the step's
// intent against the live page's interactive elements. Structured outputs
// guarantee a parseable verdict.

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
  'purpose, return null rather than guessing. Use "low" confidence whenever ' +
  'more than one candidate could plausibly be the control.';

export const POST = aiRoute('heal', { limit: 60, windowMs: 60_000 }, async (body, client) => {
  const req = parseHealRequest(body);
  if (req.candidates.length === 0) {
    return { match: null, confidence: 'low', reason: 'no interactive elements on the page' } satisfies HealVerdict;
  }

  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    messages: [{ role: 'user', content: renderHealPrompt(req) }],
  });

  if (response.stop_reason === 'refusal') {
    return { match: null, confidence: 'low', reason: 'model declined the request' } satisfies HealVerdict;
  }
  let verdict: HealVerdict;
  try {
    verdict = JSON.parse(firstText(response)) as HealVerdict;
  } catch {
    return { match: null, confidence: 'low', reason: 'model returned no verdict' } satisfies HealVerdict;
  }
  if (
    verdict.match != null &&
    (!Number.isInteger(verdict.match) || verdict.match < 0 || verdict.match >= req.candidates.length)
  ) {
    return { match: null, confidence: 'low', reason: 'model returned an invalid index' } satisfies HealVerdict;
  }
  return verdict;
});
