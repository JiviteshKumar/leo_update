import { describeStep, validateSteps, type ObjectiveResponse } from '@leo/shared';
import { AI_MAX_TOKENS, AI_MODEL, Refused, aiRoute, firstText } from '@/lib/ai/anthropic';
import { BadRequest } from '@/lib/ai/requests';

// Objective derivation: one call at record time that turns the step list
// into a name + one-line goal, later fed to the healer/agent as context.

const OBJECTIVE_SCHEMA = {
  type: 'object' as const,
  properties: {
    name: { type: 'string', description: 'A short imperative title, at most 6 words.' },
    objective: {
      type: 'string',
      description: 'One sentence: what the whole workflow accomplishes for the user.',
    },
  },
  required: ['name', 'objective'],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  'You summarize a recorded browser automation. Given its ordered steps, ' +
  'return a short imperative name and a one-sentence objective describing ' +
  'what the whole workflow accomplishes for the user. Be concrete; name the ' +
  'site or task when it is clear from the steps.';

export const POST = aiRoute(
  'objective',
  { limit: 20, windowMs: 60_000 },
  async (body, client): Promise<ObjectiveResponse> => {
    const steps = validateSteps((body as { steps?: unknown } | null)?.steps);
    if (!steps.ok) throw new BadRequest(steps.error);
    const lines = steps.value
      .slice(0, 200)
      .map((s, i) => `${i + 1}. ${describeStep(s)}`)
      .join('\n');

    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: AI_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: OBJECTIVE_SCHEMA } },
      messages: [{ role: 'user', content: `Steps:\n${lines}` }],
    });
    if (response.stop_reason === 'refusal') throw new Refused();
    const parsed = JSON.parse(firstText(response)) as Partial<ObjectiveResponse>;
    return { name: (parsed.name ?? '').trim(), objective: (parsed.objective ?? '').trim() };
  },
);
