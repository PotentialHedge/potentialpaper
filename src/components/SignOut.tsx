'use client';

import { track } from '@/lib/track';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export function SignOut({ className = 'cursor-pointer hover:underline' }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      className={className}
      onClick={async () => {
        await authClient.signOut();
        track('signed_out');
        router.push('/');
        router.refresh();
      }}
    >
      sign out
    </button>
  );
}
