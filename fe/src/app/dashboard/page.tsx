import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { deleteWorkflow, listWorkflows } from '@/app/actions/workflows';
import { auth } from '@/lib/auth';
import { SignOutButton } from './sign-out-button';

export default async function Dashboard() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/');

  const items = await listWorkflows();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          Leo<span className="text-amber-400">.</span>
        </h1>
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <span>{session.user.email}</span>
          <SignOutButton />
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Synced workflows</h2>
        {items.length === 0 && (
          <p className="text-sm text-neutral-400">
            Nothing synced yet. Record a workflow in the Leo extension and it
            will appear here.
          </p>
        )}
        {items.map((wf) => (
          <div
            key={wf.id}
            className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3"
          >
            <div>
              <div className="font-medium">{wf.name}</div>
              <div className="text-xs text-neutral-400">
                {wf.steps.length} steps
                {wf.healCount > 0 && ` · repaired ${wf.healCount}x by AI`}
                {' · updated '}
                {wf.updatedAt.toLocaleDateString()}
              </div>
            </div>
            <form
              action={async () => {
                'use server';
                await deleteWorkflow(wf.id);
              }}
            >
              <button className="text-sm text-red-400 hover:text-red-300">
                Delete
              </button>
            </form>
          </div>
        ))}
      </section>
    </main>
  );
}
