// Helpers for the browser agent's observations (pure, so they're tested).

// What visibly changed between two observations, as words that appeared or
// disappeared from the page text ('added "October"; removed "September"').
// The clearest signal that an action worked — or did nothing — for any
// model, and the only one a text-only model gets.
export const pageChanges = (before: string, after: string): string => {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const w of s.split(/\s+/).filter(Boolean)) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  const added = [...b].filter(([w, n]) => n > (a.get(w) ?? 0)).map(([w]) => w);
  const removed = [...a].filter(([w, n]) => n > (b.get(w) ?? 0)).map(([w]) => w);
  if (!added.length && !removed.length) return 'no visible change';
  const list = (ws: string[]) =>
    ws
      .slice(0, 12)
      .map((w) => `"${w.slice(0, 30)}"`)
      .join(', ') + (ws.length > 12 ? `, … (${ws.length - 12} more)` : '');
  return [added.length ? `added ${list(added)}` : '', removed.length ? `removed ${list(removed)}` : '']
    .filter(Boolean)
    .join('; ');
};
