'use client';

import { useState, useEffect, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { APPROVAL_ERROR_CODES } from '@/types/auth';

function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [expiredMessage, setExpiredMessage] = useState(false);
  
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get('reason') === 'expired') {
      setExpiredMessage(true);
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await signIn('credentials', {
        redirect: false,
        username,
        password,
      });

      if (result?.error) {
        if (result.error === APPROVAL_ERROR_CODES.PENDING) {
          setError('Your account is awaiting admin approval.');
        } else if (result.error === APPROVAL_ERROR_CODES.REJECTED) {
          setError('Your account request was rejected. Contact support/admin.');
        } else {
          setError('Invalid username or password');
        }
      } else {
        // Use a hard redirect to ensure the session is properly picked up
        // and avoid race conditions with client-side session state
        window.location.href = '/dashboard';
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8">
        <div className="flex flex-col items-center mb-8">
          <Link href="/" className="mb-4">
            <Image src="/growmystock_logo.svg" alt="GrowMyStock Logo" width={64} height={64} />
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Login</h1>
          <p className="text-gray-600">Welcome back to GrowMyStock</p>
        </div>

        <form onSubmit={handleSubmit}>
          {expiredMessage && (
            <div className="bg-amber-100 border-2 border-amber-400 text-amber-700 px-4 py-3 rounded-lg relative mb-4 text-sm font-medium" role="alert">
              <span className="block sm:inline">Your session expired. Please sign in again.</span>
            </div>
          )}
          <div className="mb-4">
            <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-600 focus:border-green-600 transition duration-200"
              placeholder="e.g. KevinBollman"
              required
            />
          </div>
          <div className="mb-2">
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-600 focus:border-green-600 transition duration-200"
              required
            />
          </div>
          <div className="mb-6 text-right">
            <Link href="/forgot-password" className="text-sm hover:text-green-800" style={{ color: '#005a00' }}>
              Forgot password?
            </Link>
          </div>
          {error && (
            <div className="bg-red-100 border-2 border-red-400 text-red-700 px-4 py-3 rounded-lg relative mb-4" role="alert">
              <span className="block sm:inline">{error}</span>
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{ backgroundColor: '#017e3b' }}
            className="w-full hover:opacity-90 text-white py-2 px-4 rounded-lg transition duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-600 disabled:opacity-50 cursor-pointer"
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
        <p className="mt-6 text-center text-gray-600">
          Don't have an account?{' '}
          <Link href="/register" className="hover:text-green-800 font-medium" style={{ color: "#005a00" }}>
            Register here
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 flex flex-col items-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
