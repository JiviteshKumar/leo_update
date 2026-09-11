// Fixture server for the e2e suite.
//
//  - Serves the test pages in ./pages on two origins: 127.0.0.1:4321 (the
//    "main" site) and localhost:4322 (a different site, for cross-origin
//    iframes).
//  - Stands in for the Leo web app at 127.0.0.1:4321: the session endpoint
//    reports "signed out" (no cloud sync) and /api/ai/* answers from a queue
//    of mock responses that tests program via /__mock/*.
//
// Mock responses can say `pickText` instead of a candidate index; the server
// resolves it against the candidates in the request, so tests don't depend on
// the page's element order.

const PAGES = new URL('./pages/', import.meta.url);

type Json = Record<string, unknown>;

interface MockState {
  heal: Json[];
  agent: Json[];
  objective: Json[];
}

let mock: MockState = { heal: [], agent: [], objective: [] };
let log: { path: string; body: unknown }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const findIndexByText = (candidates: { text?: string }[], pickText: string): number | null => {
  const needle = pickText.toLowerCase();
  const exact = candidates.findIndex((c) => (c.text ?? '').toLowerCase() === needle);
  if (exact >= 0) return exact;
  const partial = candidates.findIndex((c) => (c.text ?? '').toLowerCase().includes(needle));
  return partial >= 0 ? partial : null;
};

// Pull "[3] <button …> Send form @ (…)" lines out of the newest agent
// observation so a mock tool call can target an element by its text.
const agentIndexByText = (body: Json, pickText: string): number | null => {
  const messages = (body.messages as { content: unknown }[]) ?? [];
  const last = messages[messages.length - 1];
  const texts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Json;
      if (o.type === 'text' && typeof o.text === 'string') texts.push(o.text);
      if (o.content) walk(o.content);
    }
  };
  walk(last?.content);
  const needle = pickText.toLowerCase();
  for (const t of texts) {
    for (const line of t.split('\n')) {
      const m = /^\[(\d+)\] <[^>]*> (.*?)(?: @ \(.*\))?$/.exec(line);
      if (m && m[2].toLowerCase().includes(needle)) return Number(m[1]);
    }
  }
  return null;
};

let toolId = 0;

const answerAi = (kind: keyof MockState, body: Json): Response => {
  const next = mock[kind].shift();
  if (!next) return json({ error: `no ${kind} mock queued`, code: 'provider_error' }, 502);
  if (next.status) return json(next.body, next.status as number);

  if (kind === 'heal' && typeof next.pickText === 'string') {
    const index = findIndexByText((body.candidates as { text?: string }[]) ?? [], next.pickText);
    return json({ match: index, confidence: next.confidence ?? 'high', reason: 'mock' });
  }
  if (kind === 'agent' && Array.isArray(next.tools)) {
    const content = (next.tools as Json[]).map((t) => {
      const input = { ...(t.input as Json) };
      if (typeof input.pickText === 'string') {
        input.index = agentIndexByText(body, input.pickText);
        delete input.pickText;
      }
      return { type: 'tool_use', id: `toolu_mock_${++toolId}`, name: t.name, input };
    });
    return json({ content, stop_reason: 'tool_use' });
  }
  return json(next);
};

const handler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/__health') return json({ ok: true });
  if (path === '/__mock/reset') {
    mock = { heal: [], agent: [], objective: [] };
    log = [];
    return json({ ok: true });
  }
  if (path === '/__mock/queue' && req.method === 'POST') {
    const body = (await req.json()) as Partial<MockState>;
    for (const k of ['heal', 'agent', 'objective'] as const) {
      if (body[k]) mock[k].push(...body[k]);
    }
    return json({ ok: true });
  }
  if (path === '/__mock/log') return json(log);

  // Leo web app stand-ins.
  if (path === '/api/auth/get-session') return json(null);
  if (path.startsWith('/api/workflows')) return json({ error: 'unauthorized' }, 401);
  if (path.startsWith('/api/ai/')) {
    const kind = path.split('/')[3] as keyof MockState;
    const body = (await req.json().catch(() => ({}))) as Json;
    log.push({ path, body });
    if (!(kind in mock)) return json({ error: 'unknown', code: 'bad_request' }, 404);
    return answerAi(kind, body);
  }

  // Downloads.
  if (path === '/files/report.txt') {
    return new Response('leo e2e report\n', {
      headers: {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="leo-report.txt"',
      },
    });
  }

  // Static pages.
  const name = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
  if (name.includes('..') || name.includes('\\')) return new Response('forbidden', { status: 403 });
  const file = Bun.file(new URL(name, PAGES));
  if (!(await file.exists())) return new Response('not found', { status: 404 });
  return new Response(file, { headers: { 'Cache-Control': 'no-store' } });
};

Bun.serve({ hostname: '127.0.0.1', port: 4321, fetch: handler });
Bun.serve({ hostname: '127.0.0.1', port: 4322, fetch: handler });
console.log('fixtures on http://127.0.0.1:4321 and http://localhost:4322');
