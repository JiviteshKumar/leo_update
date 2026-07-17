import type { Account, Workflow } from './types';

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

// ---------------------------------------------------------------------------
// Workflow sync (cookie-authenticated /api/workflows endpoints)
// ---------------------------------------------------------------------------

// null = fe unreachable or signed out; callers skip the sync quietly.
export const pullWorkflows = async (): Promise<Workflow[] | null> => {
  try {
    const res = await fetch(`${FE_URL}/api/workflows`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as { workflows?: Workflow[] };
    return data.workflows ?? null;
  } catch {
    return null;
  }
};

export const pushWorkflow = async (wf: Workflow): Promise<boolean> => {
  try {
    const res = await fetch(`${FE_URL}/api/workflows`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wf),
    });
    return res.ok;
  } catch {
    return false;
  }
};

export const deleteWorkflowRemote = async (id: string): Promise<boolean> => {
  try {
    const res = await fetch(`${FE_URL}/api/workflows/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return res.ok;
  } catch {
    return false;
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
