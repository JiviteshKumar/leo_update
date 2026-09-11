import { headers } from 'next/headers';
import { auth } from '@/lib/auth';

// The signed-in user for the current request, or null. Works for both the
// dashboard (browser cookie) and the extension (which sends the same cookie
// thanks to its host permission for this origin).
export const getSessionUser = async () =>
  (await auth.api.getSession({ headers: await headers() }))?.user ?? null;
