import Anthropic from '@anthropic-ai/sdk';
import { fromOpenAiMessage, toOpenAiMessages, toOpenAiTools, type OaiToolCall } from './openai-format';

// The model behind Leo's AI features. Chosen on the server:
//   LEO_AI_PROVIDER=anthropic|groq forces one; otherwise Anthropic when
//   ANTHROPIC_API_KEY is set, else Groq when GROQ_API_KEY is set.
//   LEO_AI_MODEL overrides the provider's default model.
// Every provider speaks the Anthropic message shape to the rest of Leo.

export type JsonSchema = Record<string, unknown>;

export interface AgentTurn {
  content: Anthropic.ContentBlock[];
  stop_reason: string | null;
}

export interface AiProvider {
  readonly name: 'anthropic' | 'groq';
  readonly model: string;
  // Whether the model can see screenshots. Text-only models get the element
  // list and page text only.
  readonly vision: boolean;
  // A JSON object matching `schema`, or null when the model declined.
  json(opts: { system: string; user: string; schema: JsonSchema; schemaName: string }): Promise<unknown | null>;
  agentTurn(opts: { system: string; tools: Anthropic.Tool[]; messages: Anthropic.MessageParam[] }): Promise<AgentTurn>;
}

// HTTP failure from a provider without an SDK error class of its own.
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class NotConfigured extends Error {}

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5',
  groq: 'openai/gpt-oss-120b',
} as const;

// Responses include reasoning tokens on current models; leave room so the
// answer itself is never truncated.
const MAX_TOKENS = 16_000;

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const anthropicProvider = (model: string): AiProvider => {
  const client = new Anthropic(); // throws without credentials
  return {
    name: 'anthropic',
    model,
    vision: true,
    async json({ system, user, schema }) {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: user }],
      });
      if (response.stop_reason === 'refusal') return null;
      const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
      return JSON.parse(text);
    },
    async agentTurn({ system, tools, messages }) {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        // The whole conversation (tools + system + every prior screenshot)
        // is re-sent each turn; automatic caching serves that growing
        // prefix from cache instead of full price.
        cache_control: { type: 'ephemeral' },
        system,
        tools,
        messages,
      });
      return { content: response.content, stop_reason: response.stop_reason };
    },
  };
};

// ---------------------------------------------------------------------------
// Groq (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

interface ChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OaiToolCall[] | null }; finish_reason?: string }[];
}

const MAX_RETRIES = 3;
// Waits longer than this are reported instead of slept through.
const MAX_RETRY_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// How long a 429 asks us to wait: the Retry-After header, or Groq's "Please
// try again in 14.15s" message.
export const retryDelayMs = (headers: Headers, detail: string): number => {
  const header = Number(headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header * 1000) + 250;
  const m = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(detail);
  if (m) return Math.ceil((Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000) + 250;
  return 5_000;
};

const groqProvider = (model: string, apiKey: string): AiProvider => {
  // Retries what is worth retrying: token-per-minute limits (after the wait
  // Groq asks for), transient server errors, and malformed generations —
  // GPT-OSS occasionally emits an unparseable tool call
  // ("output_parse_failed") or calls a tool that doesn't exist
  // ("tool_use_failed"); a fresh sample usually fixes both.
  const chat = async (body: Record<string, unknown>): Promise<ChatResponse> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...body }),
      });
      if (res.ok) return (await res.json()) as ChatResponse;
      const detail = (await res.text().catch(() => '')).slice(0, 600);
      const parseFailed =
        res.status === 400 && (detail.includes('output_parse_failed') || detail.includes('tool_use_failed'));
      const retryable = res.status === 429 || res.status >= 500 || parseFailed;
      if (retryable && attempt < MAX_RETRIES) {
        const wait = res.status === 429 ? retryDelayMs(res.headers, detail) : 750 * (attempt + 1);
        if (wait <= MAX_RETRY_WAIT_MS) {
          console.warn(`[ai:groq] HTTP ${res.status}${parseFailed ? ' (malformed tool call)' : ''}; retrying in ${wait}ms`);
          await sleep(wait);
          continue;
        }
      }
      throw new ProviderError(`Groq returned HTTP ${res.status}: ${detail.slice(0, 400)}`, res.status);
    }
  };

  return {
    name: 'groq',
    model,
    vision: false,
    async json({ system, user, schema, schemaName }) {
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      let response: ChatResponse;
      try {
        response = await chat({
          messages,
          response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } },
          max_completion_tokens: 4_096,
          reasoning_effort: 'medium',
        });
      } catch (err) {
        // Models without schema-constrained output: ask for JSON and
        // describe the schema instead.
        if (!(err instanceof ProviderError) || err.status !== 400) throw err;
        response = await chat({
          messages: [
            { role: 'system', content: `${system}\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          max_completion_tokens: 4_096,
        });
      }
      const text = response.choices?.[0]?.message?.content ?? '';
      return JSON.parse(text);
    },
    async agentTurn({ system, tools, messages }) {
      const response = await chat({
        messages: toOpenAiMessages(system, messages, { compact: true }),
        tools: toOpenAiTools(tools),
        // Every agent turn is an action or finish(), so a tool call is
        // always the right answer; requiring one stops GPT-OSS from
        // answering in prose.
        tool_choice: 'required',
        // One action per turn: element indexes change after every action.
        parallel_tool_calls: false,
        max_completion_tokens: 8_192,
        reasoning_effort: 'medium',
      });
      return fromOpenAiMessage(response.choices?.[0]?.message ?? {});
    },
  };
};

// ---------------------------------------------------------------------------

export const createProvider = (): AiProvider => {
  const forced = (process.env.LEO_AI_PROVIDER ?? '').trim().toLowerCase();
  const name =
    forced === 'anthropic' || forced === 'groq'
      ? forced
      : process.env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : process.env.GROQ_API_KEY
          ? 'groq'
          : 'anthropic';
  const model = process.env.LEO_AI_MODEL?.trim() || DEFAULT_MODELS[name];
  if (name === 'groq') {
    const key = process.env.GROQ_API_KEY?.trim();
    if (!key) throw new NotConfigured('GROQ_API_KEY is not set on the Leo server.');
    return groqProvider(model, key);
  }
  try {
    return anthropicProvider(model);
  } catch {
    throw new NotConfigured('No AI key is set on the Leo server (ANTHROPIC_API_KEY or GROQ_API_KEY).');
  }
};
