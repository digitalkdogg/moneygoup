'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { ProfileResponse } from '@/types/api';

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  user: 'Standard Member',
  superuser: 'Super Member',
  admin: 'Administrator',
};

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: ProfileResponse };

export default function Profile() {
  const [state, setState] = useState<FetchState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/user/profile');
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.message ?? `Server error (${res.status})`);
        }
        const data: ProfileResponse = await res.json();
        if (!cancelled) setState({ status: 'success', data });
      } catch (err: any) {
        if (!cancelled) setState({ status: 'error', message: err.message ?? 'Failed to load profile' });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (state.status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-600" />
        <p className="ml-4 text-gray-500">Loading profile...</p>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (state.status === 'error') {
    return (
      <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded-lg max-w-xl mx-auto mt-8">
        <p className="font-semibold">Could not load profile</p>
        <p className="text-sm mt-1">{state.message}</p>
      </div>
    );
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  const { data } = state;
  const accountLabel = ACCOUNT_TYPE_LABELS[data.accountType] ?? data.accountType;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">My Profile</h1>

      {/* Identity card */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-center space-x-4 mb-4">
          <div
            className="h-14 w-14 rounded-full flex items-center justify-center text-xl font-bold bg-[#95c779] text-[#09522b]"
            aria-hidden="true"
          >
            {data.username.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="text-xl font-bold text-gray-900">{data.username}</p>
            <span className="inline-block mt-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
              {accountLabel}
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500 font-medium">Username</dt>
            <dd className="text-gray-900 mt-0.5">{data.username}</dd>
          </div>
          <div>
            <dt className="text-gray-500 font-medium">Account Type</dt>
            <dd className="text-gray-900 mt-0.5">{accountLabel}</dd>
          </div>
        </dl>
      </div>

      {/* Stats — only for user / superuser */}
      {data.accountType !== 'admin' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Activity Summary</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <StatCard
              label="Total Lookups"
              value={data.stats.lookupCount}
              emptyLabel="No lookups yet"
            />
            <StatCard
              label="Portfolio Positions"
              value={data.stats.portfolioItemCount}
              emptyLabel="No positions"
            />
            <StatCard
              label="Watchlist Items"
              value={data.stats.watchlistItemCount}
              emptyLabel="Watchlist empty"
            />
          </dl>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, emptyLabel }: { label: string; value: number; emptyLabel: string }) {
  return (
    <div className="p-4 bg-gray-50 rounded-lg border border-gray-100 text-center">
      <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">{label}</dt>
      <dd className="text-3xl font-bold text-gray-900">
        {value === 0
          ? <span className="text-lg text-gray-400 font-normal">{emptyLabel}</span>
          : value.toLocaleString()}
      </dd>
    </div>
  );
}
