'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

const BENEFITS = [
  { text: 'Free to join — no credit card required' },
  { text: 'AI-powered GPS scores across 10,000+ stocks' },
  { text: 'Portfolio tracking with real-time benchmarking' },
  { text: 'Machine-learning price predictions updated daily' },
];

const FEATURES = [
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#015f2d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    title: 'GPS Stock Score',
    description: 'One number that summarizes a stock\'s strength across six key financial drivers.',
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#015f2d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
    title: 'AI Price Predictions',
    description: 'ML-generated price targets so you know where analysts and models align.',
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#015f2d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
    title: 'Portfolio Analytics',
    description: 'Track holdings, visualize performance, and compare against benchmarks.',
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#015f2d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    title: 'Analyst Consensus',
    description: 'Aggregated Wall Street ratings and price targets in one place.',
  },
];

export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8 || !/\d/.test(password)) {
      setError('Password must be at least 8 characters and contain at least one number.');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });

      if (res.ok) {
        setSuccess('Registration successful! Your account is pending admin approval. You will be able to log in once an admin has approved your account.');
      } else {
        const data = await res.json();
        setError(data.message || 'Registration failed');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-green-50 flex flex-col items-center px-4 py-16">

      {/* H1 page title */}
      <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 text-center mb-6 max-w-xl leading-tight">
        GrowMyStocks Registration &mdash; Start Analyzing Stocks with AI Today
      </h1>

      {/* Register card */}
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border-t-4 p-8" style={{ borderColor: '#017e3b' }}>
        <div className="flex flex-col items-center mb-8">
          <Link href="/" className="mb-4">
            <Image src="/growmystock_logo.svg" alt="GrowMyStocks Logo" width={64} height={64} />
          </Link>
          <h2 className="text-xl font-bold text-gray-800">Create your account</h2>
          <p className="text-gray-500 text-sm mt-1">Free to join. No credit card required.</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-600 focus:border-green-600 transition duration-200"
              required
            />
          </div>
          <div className="mb-4">
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
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
          <div className="mb-6">
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
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
          {error && (
            <div className="bg-red-100 border-2 border-red-400 text-red-700 px-4 py-3 rounded-lg relative mb-4" role="alert">
              <span className="block sm:inline">{error}</span>
            </div>
          )}
          {success && (
            <div className="bg-green-100 border-2 border-green-400 text-green-800 px-4 py-3 rounded-lg relative mb-4" role="alert">
              <span className="block sm:inline">{success}</span>
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{ backgroundColor: '#017e3b' }}
            className="w-full hover:opacity-90 text-white py-2 px-4 rounded-lg transition duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-600 disabled:opacity-50"
          >
            {loading ? 'Creating account...' : 'Create Free Account'}
          </button>
        </form>

        <p className="mt-6 text-center text-gray-600 text-sm">
          Already have an account?{' '}
          <Link href="/login" className="hover:text-green-800 font-medium" style={{ color: '#005a00' }}>
            Log in here
          </Link>
        </p>
      </div>

      {/* Benefits strip */}
      <div className="w-full max-w-2xl mt-16 bg-white rounded-xl shadow-sm border border-green-100 px-6 py-5">
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {BENEFITS.map((b) => (
            <li key={b.text} className="flex items-start gap-2.5">
              <svg className="shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#017e3b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="text-sm text-gray-600">{b.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* What you get section */}
      <div className="w-full max-w-4xl mt-16 text-center mb-4">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">
          Everything you need to invest smarter
        </h2>
        <p className="text-gray-500 text-sm max-w-xl mx-auto">
          Your account unlocks every tool on the platform — from AI stock scores to portfolio analytics — with no paywalls or hidden tiers.
        </p>
      </div>

      {/* Feature strip */}
      <div className="w-full max-w-4xl mt-10 grid grid-cols-2 sm:grid-cols-4 gap-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="bg-white rounded-xl p-4 shadow-sm border border-green-100 flex flex-col items-start gap-2">
            <div className="p-1.5 rounded-lg" style={{ backgroundColor: '#f0fdf4' }}>{f.icon}</div>
            <h3 className="text-sm font-semibold text-gray-800 leading-tight">{f.title}</h3>
            <p className="text-xs text-gray-500 leading-snug">{f.description}</p>
          </div>
        ))}
      </div>

      {/* Login CTA */}
      <div className="w-full max-w-4xl mt-10 mb-8 rounded-2xl border border-green-200 bg-white px-8 py-7 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-gray-800">Already a member?</h3>
          <p className="text-sm text-gray-500 mt-0.5">Sign in to access your dashboard, scores, and portfolio.</p>
        </div>
        <Link
          href="/login"
          className="shrink-0 inline-block border-2 font-semibold text-sm px-6 py-2.5 rounded-lg transition-colors hover:bg-green-50"
          style={{ borderColor: '#017e3b', color: '#017e3b' }}
        >
          Log In
        </Link>
      </div>

    </div>
  );
}
