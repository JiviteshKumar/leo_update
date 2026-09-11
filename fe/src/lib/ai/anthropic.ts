import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import type { AiErrorBody, AiErrorCode } from '@leo/shared';
import { hit, type RateLimit } from '@/lib/rate-limit';
import { getSessionUser } from '@/lib/session';
import { Refused, createProvider } from './core';
import { NotConfigured, ProviderError, type AiProvider } from './providers';
import { BadRequest } from './requests';

// Shared wrapper for Leo's /api/ai/* routes. Keys never leave the server:
// the extension calls these routes with the user's Leo session, and they
// call the configured model provider (see ./providers).

let provider: AiProvider | null = null;
let providerError = '';

// Null when no provider is configured.
const getProvider = (): AiProvider | null => {
  if (provider) return provider;
  try {
    provider = createProvider();
    console.info(`[ai] using ${provider.name} (${provider.model})`);
    return provider;
  } catch (err) {
    providerError = err instanceof NotConfigured ? err.message : 'No AI provider is configured on the Leo server.';
    return null;
  }
};

export const aiError = (status: number, code: AiErrorCode, error: string, init?: ResponseInit) =>
  NextResponse.json<AiErrorBody>({ error, code }, { ...init, status });

const MAX_BODY_BYTES = 25 * 1024 * 1024;

// Session auth, per-user rate limit, JSON body parsing, and mapping of
// provider errors to AiErrorBody.
export const aiRoute =
  <T>(name: string, limit: RateLimit, handler: (body: unknown, ai: AiProvider) => Promise<T>) =>
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

    const ai = getProvider();
    if (!ai) return aiError(503, 'not_configured', providerError);

    try {
      return NextResponse.json(await handler(body, ai));
    } catch (err) {
      if (err instanceof BadRequest) return aiError(400, 'bad_request', err.message);
      if (err instanceof Refused) return aiError(422, 'refused', 'The model declined this request.');
      if (err instanceof ProviderError) {
        console.error(`[ai:${name}] ${err.message}`);
        if (err.status === 401 || err.status === 403) {
          return aiError(502, 'provider_auth', "The server's AI key was rejected.");
        }
        if (err.status === 429) return aiError(429, 'provider_rate_limited', 'The AI provider is rate limiting requests.');
        return aiError(502, 'provider_error', `AI provider error (${err.status}).`);
      }
      if (err instanceof Anthropic.AuthenticationError) {
        console.error(`[ai:${name}] Anthropic rejected the server API key`);
        return aiError(502, 'provider_auth', "The server's AI key was rejected.");
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
      if (err instanceof SyntaxError) {
        console.error(`[ai:${name}] model returned malformed JSON`);
        return aiError(502, 'provider_error', 'The model returned a malformed answer.');
      }
      console.error(`[ai:${name}]`, err);
      return aiError(500, 'provider_error', 'Unexpected server error.');
    }
  };
