// Build-time configuration. Extensions have no runtime environment, so the
// key is baked into the bundle by Vite from extension/.env (see .env.example);
// set WXT_ANTHROPIC_API_KEY there and rebuild. Never committed.
export const ANTHROPIC_API_KEY: string =
  (import.meta.env.WXT_ANTHROPIC_API_KEY as string | undefined) ?? '';
