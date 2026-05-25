'use client';

import { useState, useEffect, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { APPROVAL_ERROR_CODES } from '@/types/auth';

const FEATURES = [
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#017e3b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    title: 'GPS Stock Score',
    description: 'AI rates every stock 0–100 across six financial signals.',
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#017e3b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
    title: 'AI Predictions',
    description: 'Machine-learning price targets with confidence scores.',
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#017e3b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
    title: 'Portfolio Tracking',
    description: 'Monitor your holdings and benchmark against the market.',
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#017e3b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
    title: 'Deep Stock Data',
    description: 'Analyst ratings, financials, and sector comparisons.',
  },
];

const STATS = [
  { value: '10,000+', label: 'Stocks Scored' },
  { value: '6', label: 'Financial Signals' },
  { value: 'Daily', label: 'Data Updates' },
  { value: 'Free', label: 'To Get Started' },
];

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
        window.location.href = '/dashboard';
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center px-4 py-16">

      {/* H1 page title — SEO anchor, sits above the login card */}
      <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 text-center mb-6 max-w-xl leading-tight">
        GrowMyStocks Login &mdash; Use the Power of AI to Rate Your Stocks
      </h1>

      {/* Login card */}
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
        <div className="flex flex-col items-center mb-8">
          <Link href="/" className="mb-4">
            <Image src="/growmystock_logo.svg" alt="GrowMyStocks Logo" width={64} height={64} />
          </Link>
          <h2 className="text-xl font-bold text-gray-800">Welcome back</h2>
          <p className="text-gray-500 text-sm mt-1">Sign in to your account</p>
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
              placeholder="Username"
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
            {loading ? 'Logging in...' : 'Log in'}
          </button>
        </form>

        <p className="mt-6 text-center text-gray-600 text-sm">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="hover:text-green-800 font-medium" style={{ color: '#005a00' }}>
            Register here
          </Link>
        </p>
      </div>

      {/* Why GrowMyStocks section */}
      <div className="w-full max-w-4xl mt-16 text-center mb-4">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-6">
          Know which stocks to buy before the market does.
        </h2>

        {/* Social proof bar */}
        <div className="w-full max-w-2xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-center mb-6">
          {STATS.map((s) => (
            <div key={s.label}>
              <p className="text-xl font-bold" style={{ color: '#017e3b' }}>{s.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        <p className="text-gray-500 text-sm max-w-xl mx-auto">
          Our model scores every stock across six financial signals — analyst upside, revenue growth, earnings growth, price momentum, ML alpha, and AI confidence — to give you a single actionable rating.
        </p>
      </div>

      {/* Feature strip */}
      <div className="w-full max-w-4xl mt-10 grid grid-cols-2 sm:grid-cols-4 gap-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="bg-white rounded-xl p-4 shadow-sm flex flex-col items-start gap-2">
            <div className="p-1.5 bg-green-50 rounded-lg">{f.icon}</div>
            <h3 className="text-sm font-semibold text-gray-800 leading-tight">{f.title}</h3>
            <p className="text-xs text-gray-500 leading-snug">{f.description}</p>
          </div>
        ))}
      </div>

      {/* Register CTA */}
      <div className="w-full max-w-4xl mt-10 mb-8 bg-white rounded-2xl shadow-sm border border-gray-100 px-8 py-7 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-gray-800">New to GrowMyStocks?</h3>
          <p className="text-sm text-gray-500 mt-0.5">Create a free account and start analyzing stocks in minutes.</p>
        </div>
        <Link
          href="/register"
          style={{ backgroundColor: '#017e3b' }}
          className="shrink-0 inline-block hover:opacity-90 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition-opacity"
        >
          Create Free Account
        </Link>
      </div>

    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-2">
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
