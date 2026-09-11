# Leo

Teach your browser a task once. Leo records the workflow and replays it
deterministically; AI is used only when a site has changed (self-healing) or
for steps you describe in words.

## Layout

| Path | What |
|---|---|
| `extension/` | Chrome MV3 extension (WXT + React): recorder, replay engine, floating panel |
| `fe/` | Next.js web app: accounts (better-auth), workflow sync (Neon + Drizzle), and the `/api/ai/*` endpoints that hold the Anthropic key |
| `packages/shared/` | `@leo/shared`: workflow model, validation, sync merge, step helpers — used by both apps |
| `e2e/` | Playwright suite: loads the built extension into Chromium and records/replays against local fixture sites |

## Setup

```bash
bun install
cp fe/.env.example fe/.env.local          # fill in DATABASE_URL, auth, ANTHROPIC_API_KEY
cp extension/.env.example extension/.env  # optional: WXT_LEO_FE_URL (default http://localhost:3010)
bun run --cwd fe db:push
```

Run the web app with `bun run dev:fe` (http://localhost:3010) and the
extension with `bun run dev:ext`, or build with `bun run build` and load
`extension/.output/chrome-mv3` as an unpacked extension.

The extension never holds an API key: AI repair, AI steps and workflow
naming go through `fe`'s `/api/ai/*` routes, authenticated by the user's Leo
session and rate-limited per user.

## Checks

```bash
bun run check   # typecheck all packages, lint, unit tests
bun run build   # production builds of the extension and the web app
bun run e2e     # end-to-end suite (builds its own e2e flavour of the extension)
```

The e2e suite needs Playwright's Chromium (`bun x playwright install
chromium` in `e2e/`); branded Chrome and Edge ignore `--load-extension`. If
that Chromium can't start on your machine (security software sometimes
blocks its install folder), copy `%LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win64`
somewhere it can run and point the suite at it:

```bash
LEO_E2E_CHROMIUM="C:\path\to\chrome-win64\chrome.exe" bun run e2e
```

## How replay works

1. **Deterministic first.** Each recorded step keeps up to 10 ranked
   selectors (test ids, labels, text, anchored paths, shadow-DOM chains).
   Weak matches must still look like the recorded element.
2. **Real input.** Leo waits until the element is visible, enabled, still
   and not covered, then clicks and types through the Chrome debugger, so
   sites that ignore synthetic events work. Chrome shows a "debugging" bar
   during runs; if it's dismissed, Leo falls back to page-level events.
3. **No races.** Navigations, downloads and new tabs are awaited from before
   the step that causes them; after each action the page is given time to
   settle.
4. **Self-healing.** If no selector matches, a text-only AI match is tried;
   low-confidence answers go to a vision agent instead of being clicked. A
   successful repair is saved, so the next run needs no AI.
5. **Recoverable.** A failed step pauses the run (retry / skip / end); a
   stopped run can resume from the step it stopped at. Passwords and files
   are never stored — the run pauses for the user.
