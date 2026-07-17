'use client';

import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="rounded-md border border-neutral-700 px-3 py-1 text-sm transition hover:border-neutral-500"
      onClick={() =>
        void authClient.signOut().then(() => {
          router.push('/');
          router.refresh();
        })
      }
    >
      Sign out
    </button>
  );
}
