'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (res.status === 429) {
        setError('Too many requests. Please wait a few minutes before trying again.');
        return;
      }

      // Always show the success state — server never reveals if email exists
      setSubmitted(true);
    } catch {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 section-forgot-password-form">
        <div className="flex flex-col items-center mb-8">
          <Link href="/" className="mb-4">
            <Image src="/growmystock_logo.svg" alt="GrowMyStocks Logo" width={64} height={64} />
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Forgot Password</h1>
          <p className="text-gray-600 text-center mt-1">
            Enter your email address and we&apos;ll send you a reset link.
          </p>
        </div>

        {submitted ? (
          <div>
            <div className="border-2 border-green-400 text-green-800 px-4 py-3 rounded-lg mb-6 text-sm bg-[#a8d78d]">
              If that email address is registered, you will receive a password reset link shortly. Check your inbox (and spam folder).
            </div>
            <Link
              href="/login"
              className="block w-full text-center font-medium py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition duration-200"
            >
              Back to Login
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="mb-6">
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email Address
              </label>
              <input
                type="email"
                id="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-600 focus:border-green-600 transition duration-200"
                placeholder="you@example.com"
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
              className="w-full hover:opacity-90 text-white py-2 px-4 rounded-lg transition duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-600 disabled:opacity-50 cursor-pointer bg-[#017e3b]"
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>
            <p className="mt-4 text-center text-gray-600">
              <Link href="/login" className="hover:text-green-800 font-medium text-[#005a00]">
                Back to Login
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
