'use server';

import { and, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import { workflows } from '@/db/schema';
import { auth } from '@/lib/auth';
import type { Workflow } from '@/lib/types';

const requireUser = async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Not signed in.');
  return session.user;
};

export const listWorkflows = async () => {
  const user = await requireUser();
  return db
    .select()
    .from(workflows)
    .where(eq(workflows.userId, user.id))
    .orderBy(desc(workflows.updatedAt));
};

export const saveWorkflow = async (wf: Workflow): Promise<void> => {
  const user = await requireUser();
  await db
    .insert(workflows)
    .values({
      id: wf.id,
      userId: user.id,
      name: wf.name,
      startUrl: wf.startUrl,
      steps: wf.steps,
      healCount: wf.healCount,
      createdAt: new Date(wf.createdAt),
      updatedAt: new Date(wf.updatedAt),
    })
    .onConflictDoUpdate({
      target: workflows.id,
      set: {
        name: wf.name,
        startUrl: wf.startUrl,
        steps: wf.steps,
        healCount: wf.healCount,
        updatedAt: new Date(wf.updatedAt),
      },
      // A colliding id owned by another user updates nothing.
      setWhere: eq(workflows.userId, user.id),
    });
  revalidatePath('/dashboard');
};

export const deleteWorkflow = async (id: string): Promise<void> => {
  const user = await requireUser();
  await db
    .delete(workflows)
    .where(and(eq(workflows.id, id), eq(workflows.userId, user.id)));
  revalidatePath('/dashboard');
};
