'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import {
  deleteUserWorkflow,
  listUserWorkflows,
  upsertUserWorkflow,
} from '@/lib/workflows-db';
import type { Workflow } from '@/lib/types';

const requireUser = async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Not signed in.');
  return session.user;
};

export const listWorkflows = async () => {
  const user = await requireUser();
  return listUserWorkflows(user.id);
};

export const saveWorkflow = async (wf: Workflow): Promise<void> => {
  const user = await requireUser();
  await upsertUserWorkflow(user.id, wf);
  revalidatePath('/dashboard');
};

export const deleteWorkflow = async (id: string): Promise<void> => {
  const user = await requireUser();
  await deleteUserWorkflow(user.id, id);
  revalidatePath('/dashboard');
};
