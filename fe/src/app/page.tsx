import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { AuthForm } from './auth-form';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const fromExtension = from === 'extension';
  const session = await auth.api.getSession({ headers: await headers() });

  // The extension sends users here with ?from=extension; once signed in,
  // it picks up the session on its own, so just tell them to head back.
  if (session && fromExtension) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
        <h1 className="text-4xl font-bold">
          Leo<span className="text-amber-400">.</span>
        </h1>
        <p className="max-w-sm text-center text-neutral-400">
          You&apos;re signed in as{' '}
          <span className="text-neutral-200">{session.user.email}</span>. You can
          close this tab and head back to the Leo side panel.
        </p>
      </main>
    );
  }
  if (session) redirect('/dashboard');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold">
        Leo<span className="text-amber-400">.</span>
      </h1>
      <p className="max-w-sm text-center text-neutral-400">
        Teach your browser a task once. Sign in to sync your recorded workflows
        across devices.
      </p>
      <AuthForm callbackURL={fromExtension ? '/?from=extension' : '/dashboard'} />
    </main>
  );
}
