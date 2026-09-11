import { aiRoute } from '@/lib/ai/anthropic';
import { heal } from '@/lib/ai/core';

// AI self-healing for a step whose recorded selectors all failed.
export const POST = aiRoute('heal', { limit: 60, windowMs: 60_000 }, heal);
