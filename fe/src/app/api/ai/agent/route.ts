import { aiRoute } from '@/lib/ai/anthropic';
import { agentTurn } from '@/lib/ai/core';

// One turn of the browser agent (AI steps and vision recovery).

// Long agent turns can take a while on hosted platforms.
export const maxDuration = 120;

export const POST = aiRoute('agent', { limit: 120, windowMs: 60_000 }, agentTurn);
