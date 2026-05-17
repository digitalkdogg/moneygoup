'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') ?? '';

  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [tokenError, setTokenError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenValid(false);
      setTokenError('No reset token found. Please request a new password reset link.');
      return;
    }

    fetch(`/api/auth/reset-password?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.valid) {
          setTokenValid(true);
        } else {
          setTokenValid(false);
          setTokenError(data.message || 'Invalid or expired reset link.');
        }
      })
      .catch(() => {
        setTokenValid(false);
        setTokenError('Unable to validate reset link. Please try again.');
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8 || !/\d/.test(password)) {
      setError('Password must be at least 8 characters and contain at least one number.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess(true);
        setTimeout(() => router.push('/login'), 3000);
      } else {
        setError(data.message || 'Failed to reset password. Please try again.');
      }
    } catch {
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
          <h1 className="text-3xl font-bold text-gray-800">Reset Password</h1>
        </div>

        {tokenValid === null && (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-600" />
          </div>
        )}

        {tokenValid === false && (
          <div>
            <div className="bg-red-100 border-2 border-red-400 text-red-700 px-4 py-3 rounded-lg mb-6 text-sm" role="alert">
              {tokenError}
            </div>
            <Link
              href="/forgot-password"
              style={{ backgroundColor: '#017e3b' }}
              className="block w-full text-center hover:opacity-90 text-white py-2 px-4 rounded-lg transition duration-200"
            >
              Request New Reset Link
            </Link>
          </div>
        )}

        {tokenValid === true && !success && (
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                New Password
              </label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-600 focus:border-green-600 transition duration-200"
                required
              />
              <p className="text-xs text-gray-500 mt-1">At least 8 characters and one number.</p>
            </div>
            <div className="mb-6">
              <label htmlFor="confirm" className="block text-sm font-medium text-gray-700 mb-1">
                Confirm New Password
              </label>
              <input
                type="password"
                id="confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-600 focus:border-green-600 transition duration-200"
                required
              />
            </div>
            {error && (
              <div className="bg-red-100 border-2 border-red-400 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm" role="alert">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              style={{ backgroundColor: '#017e3b' }}
              className="w-full hover:opacity-90 text-white py-2 px-4 rounded-lg transition duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-600 disabled:opacity-50 cursor-pointer"
            >
              {loading ? 'Saving...' : 'Set New Password'}
            </button>
          </form>
        )}

        {success && (
          <div>
            <div style={{ backgroundColor: '#a8d78d' }} className="border-2 border-green-400 text-green-800 px-4 py-3 rounded-lg mb-4 text-sm">
              Password updated successfully! Redirecting to login...
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 flex flex-col items-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mb-4" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}
