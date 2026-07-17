import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  listUserWorkflows,
  toWireWorkflow,
  upsertUserWorkflow,
} from '@/lib/workflows-db';
import type { Workflow } from '@/lib/types';

// Cookie-authenticated endpoints for the Leo extension. Cross-site pages
// can't reach them with credentials (the session cookie is SameSite=Lax);
// the extension can, thanks to its host permission for this origin.

const getUser = async () =>
  (await auth.api.getSession({ headers: await headers() }))?.user ?? null;

const unauthorized = () =>
  NextResponse.json({ error: 'unauthorized' }, { status: 401 });

export async function GET() {
  const user = await getUser();
  if (!user) return unauthorized();
  const rows = await listUserWorkflows(user.id);
  return NextResponse.json({ workflows: rows.map(toWireWorkflow) });
}

export async function PUT(req: Request) {
  const user = await getUser();
  if (!user) return unauthorized();
  const wf = (await req.json().catch(() => null)) as Workflow | null;
  if (
    !wf ||
    typeof wf.id !== 'string' ||
    !wf.id ||
    typeof wf.name !== 'string' ||
    typeof wf.startUrl !== 'string' ||
    typeof wf.healCount !== 'number' ||
    typeof wf.createdAt !== 'number' ||
    typeof wf.updatedAt !== 'number' ||
    !Array.isArray(wf.steps)
  ) {
    return NextResponse.json({ error: 'invalid workflow' }, { status: 400 });
  }
  await upsertUserWorkflow(user.id, wf);
  return NextResponse.json({ ok: true });
}
