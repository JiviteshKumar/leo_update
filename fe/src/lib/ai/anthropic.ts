import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import type { AiErrorBody, AiErrorCode } from '@leo/shared';
import { hit, type RateLimit } from '@/lib/rate-limit';
import { getSessionUser } from '@/lib/session';
import { BadRequest } from './requests';

// Server-side Anthropic access for Leo's AI features. The key never leaves
// the server: the extension calls /api/ai/*, authenticated by the user's Leo
// session, and these routes call Claude.

// One model for every AI call. Override with LEO_AI_MODEL.
export const AI_MODEL = process.env.LEO_AI_MODEL || 'claude-sonnet-5';

// Responses include adaptive thinking on current models; leave room so the
// answer itself is never truncated.
export const AI_MAX_TOKENS = 16_000;

let client: Anthropic | null = null;

// Null when no credentials are configured (the SDK constructor throws).
const getClient = (): Anthropic | null => {
  if (client) return client;
  try {
    client = new Anthropic();
    return client;
  } catch {
    return null;
  }
};

export const aiError = (status: number, code: AiErrorCode, error: string, init?: ResponseInit) =>
  NextResponse.json<AiErrorBody>({ error, code }, { ...init, status });

export class Refused extends Error {}

const MAX_BODY_BYTES = 25 * 1024 * 1024;

// Shared wrapper for every /api/ai/* route: session auth, per-user rate
// limit, JSON body parsing, and mapping of provider errors to AiErrorBody.
export const aiRoute =
  <T>(
    name: string,
    limit: RateLimit,
    handler: (body: unknown, client: Anthropic) => Promise<T>,
  ) =>
  async (req: Request): Promise<Response> => {
    const user = await getSessionUser();
    if (!user) return aiError(401, 'unauthorized', 'Sign in to Leo to use AI features.');

    const rl = hit(`${name}:${user.id}`, limit);
    if (!rl.ok) {
      return aiError(429, 'rate_limited', 'Too many AI requests. Try again shortly.', {
        headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) },
      });
    }

    const length = Number(req.headers.get('content-length') ?? 0);
    if (length > MAX_BODY_BYTES) return aiError(413, 'bad_request', 'Request is too large.');
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return aiError(400, 'bad_request', 'Body must be JSON.');
    }

    const anthropic = getClient();
    if (!anthropic) {
      return aiError(503, 'not_configured', 'ANTHROPIC_API_KEY is not set on the Leo server.');
    }

    try {
      return NextResponse.json(await handler(body, anthropic));
    } catch (err) {
      if (err instanceof BadRequest) return aiError(400, 'bad_request', err.message);
      if (err instanceof Refused) return aiError(422, 'refused', 'The model declined this request.');
      if (err instanceof Anthropic.AuthenticationError) {
        console.error(`[ai:${name}] Anthropic rejected the server API key`);
        return aiError(502, 'provider_auth', "The server's Anthropic API key was rejected.");
      }
      if (err instanceof Anthropic.RateLimitError) {
        return aiError(429, 'provider_rate_limited', 'The AI provider is rate limiting requests.');
      }
      if (err instanceof Anthropic.APIConnectionError) {
        return aiError(502, 'provider_error', 'Could not reach the AI provider.');
      }
      if (err instanceof Anthropic.APIError) {
        console.error(`[ai:${name}] Anthropic API error ${err.status}: ${err.message}`);
        return aiError(502, 'provider_error', `AI provider error (${err.status ?? 'unknown'}).`);
      }
      console.error(`[ai:${name}]`, err);
      return aiError(500, 'provider_error', 'Unexpected server error.');
    }
  };

// Text of the first text block, for structured-output responses.
export const firstText = (msg: Anthropic.Message): string =>
  msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
