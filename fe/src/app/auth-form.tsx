'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export function AuthForm({ callbackURL = '/dashboard' }: { callbackURL?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error } =
      mode === 'sign-up'
        ? await authClient.signUp.email({ name: name.trim() || email, email, password })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message ?? 'Something went wrong.');
      return;
    }
    router.push(callbackURL);
    router.refresh();
  };

  return (
    <div className="flex w-full max-w-xs flex-col gap-4">
      <button
        className="rounded-lg bg-amber-400 px-5 py-2.5 font-semibold text-neutral-900 transition hover:bg-amber-300"
        onClick={() =>
          void authClient.signIn.social({ provider: 'google', callbackURL })
        }
      >
        Continue with Google
      </button>

      <div className="flex items-center gap-3 text-xs text-neutral-500">
        <span className="h-px flex-1 bg-neutral-800" />
        or
        <span className="h-px flex-1 bg-neutral-800" />
      </div>

      <form className="flex flex-col gap-3" onSubmit={submit}>
        {mode === 'sign-up' && (
          <input
            className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-amber-400"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <input
          className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-amber-400"
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-amber-400"
          type="password"
          required
          minLength={8}
          placeholder="Password (min. 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          className="rounded-lg border border-neutral-700 px-5 py-2 font-medium transition hover:border-neutral-500 disabled:opacity-50"
          type="submit"
          disabled={busy}
        >
          {busy ? '…' : mode === 'sign-up' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <button
        className="text-sm text-neutral-400 underline-offset-2 hover:underline"
        onClick={() => {
          setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
          setError(null);
        }}
      >
        {mode === 'sign-in'
          ? "Don't have an account? Create one"
          : 'Already have an account? Sign in'}
      </button>
    </div>
  );
}
