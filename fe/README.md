# Leo fe

Next.js app for Leo accounts: authentication (better-auth, Google OAuth) and
cloud sync of recorded workflows, backed by Neon Postgres via Drizzle and
server actions.

## Setup

1. **Neon** — create a project at [neon.tech](https://neon.tech) and copy the
   connection string into `DATABASE_URL` in `.env.local`.
2. **Google OAuth** — create an OAuth client at
   [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
   (type: Web application) with authorized redirect URI
   `http://localhost:3010/api/auth/callback/google`, then fill in
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.local`.
3. **Create tables** — `bun run db:push`
4. **Run** — `bun dev`, then open http://localhost:3010.

## Layout

- `src/db/` — Drizzle client (`index.ts`), better-auth tables
  (`auth-schema.ts`), app tables (`schema.ts` — `workflows`).
- `src/lib/auth.ts` — better-auth server instance; mounted at
  `src/app/api/auth/[...all]/route.ts`.
- `src/lib/auth-client.ts` — React auth client for sign-in/sign-out.
- `src/app/actions/workflows.ts` — session-guarded server actions
  (list / upsert / delete workflows).
- `src/lib/types.ts` — copy of the extension's `Workflow`/`Step` types
  (`../src/utils/types.ts`); keep both in sync when the step shape changes.

## Scripts

- `bun dev` — dev server
- `bun run build` — production build
- `bun run db:push` — push schema to Neon (dev)
- `bun run db:generate` — generate SQL migrations

## Extension auth flow

The extension's "Sign in" opens `/?from=extension` in a tab; after Google
sign-in the page tells the user to return to the side panel, and the
extension picks up the session by calling `/api/auth/get-session` with
cookies (its `<all_urls>` host permission exempts it from CORS/SameSite).
Set `EXTENSION_ORIGIN` in `.env.local` to the extension's
`chrome-extension://<id>` origin so its sign-out POST passes better-auth's
CSRF origin check. The fe origin used by the extension is
`extension/src/utils/fe.ts` → `FE_URL`.
