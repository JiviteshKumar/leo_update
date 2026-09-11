import { aiRoute } from '@/lib/ai/anthropic';
import { objective } from '@/lib/ai/core';

// Name + one-line objective for a freshly recorded workflow.
export const POST = aiRoute('objective', { limit: 20, windowMs: 60_000 }, objective);
