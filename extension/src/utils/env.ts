// Build-time configuration. Extensions have no runtime environment, so values
// are baked into the bundle by Vite from extension/.env (see .env.example).
//
// No secrets belong here: everything in the bundle is readable by anyone who
// installs the extension. AI calls go through the Leo web app, which holds
// the Anthropic key server-side.

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

// Where the Leo web app (fe/) runs. Auth is cookie-based: the extension has
// host permissions for this origin, so fetches carry the better-auth session
// cookie and are exempt from CORS/SameSite — no token handling needed.
export const FE_URL: string = trimSlash(
  (import.meta.env.WXT_LEO_FE_URL as string | undefined) || 'http://localhost:3010',
);
