'use client';

import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Profile from '../components/Profile';

export default function ProfilePage() {
  const { status } = useSession();
  const router = useRouter();

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-green-600" />
        <p className="ml-4 text-lg text-gray-600">Loading session...</p>
      </div>
    );
  }

  if (status === 'unauthenticated') {
    router.push('/login?reason=expired');
    return null;
  }

  return <Profile />;
}
