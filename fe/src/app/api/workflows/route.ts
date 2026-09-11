import { NextResponse } from 'next/server';
import { validateWorkflow } from '@leo/shared';
import { getSessionUser } from '@/lib/session';
import { listUserWorkflows, toWireWorkflow, upsertUserWorkflow } from '@/lib/workflows-db';

// Cookie-authenticated endpoints for the Leo extension. Cross-site pages
// can't reach them with credentials (the session cookie is SameSite=Lax);
// the extension can, thanks to its host permission for this origin.

const unauthorized = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 });

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rows = await listUserWorkflows(user.id);
  return NextResponse.json({ workflows: rows.map(toWireWorkflow) });
}

export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = await req.json().catch(() => null);
  const result = validateWorkflow(body);
  if (!result.ok) {
    return NextResponse.json({ error: `invalid workflow: ${result.error}` }, { status: 400 });
  }
  await upsertUserWorkflow(user.id, result.value);
  return NextResponse.json({ ok: true });
}
