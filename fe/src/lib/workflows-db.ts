import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { workflows } from '@/db/schema';
import type { Workflow } from './types';

// Shared by the server actions (dashboard) and the /api/workflows route
// handlers (extension sync). All queries are scoped to the given user.

export const listUserWorkflows = async (userId: string) =>
  db
    .select()
    .from(workflows)
    .where(eq(workflows.userId, userId))
    .orderBy(desc(workflows.updatedAt));

export const upsertUserWorkflow = async (userId: string, wf: Workflow) => {
  await db
    .insert(workflows)
    .values({
      id: wf.id,
      userId,
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
      setWhere: eq(workflows.userId, userId),
    });
};

export const deleteUserWorkflow = async (userId: string, id: string) => {
  await db
    .delete(workflows)
    .where(and(eq(workflows.id, id), eq(workflows.userId, userId)));
};

// Row -> the wire/extension shape (epoch ms instead of Date).
export const toWireWorkflow = (
  row: Awaited<ReturnType<typeof listUserWorkflows>>[number],
): Workflow => ({
  id: row.id,
  name: row.name,
  startUrl: row.startUrl,
  steps: row.steps,
  healCount: row.healCount,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});
