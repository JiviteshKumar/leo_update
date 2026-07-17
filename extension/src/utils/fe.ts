import type { Account } from './types';

// Where the Leo web app (fe/) runs. Point at the deployed URL for prod
// builds. Auth works cookie-based: the extension has host permissions for
// this origin, so fetches carry the better-auth session cookie and are
// exempt from CORS/SameSite — no token handling needed.
export const FE_URL = 'http://localhost:3010';

export const fetchAccount = async (): Promise<Account | null> => {
  try {
    const res = await fetch(`${FE_URL}/api/auth/get-session`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      user?: { name: string; email: string; image?: string | null };
    } | null;
    if (!data?.user) return null;
    const { name, email, image } = data.user;
    return { name, email, image };
  } catch {
    // fe not running or offline — treat as signed out.
    return null;
  }
};

// Requires the extension's chrome-extension:// origin in fe's
// EXTENSION_ORIGIN env var (better-auth trustedOrigins), otherwise the
// CSRF origin check rejects the POST.
export const signOutFe = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${FE_URL}/api/auth/sign-out`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return res.ok;
  } catch {
    return false;
  }
};
