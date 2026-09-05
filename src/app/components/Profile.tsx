'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { ProfileResponse, ProfileStrategy } from '@/types/api';

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  user: 'Standard Member',
  superuser: 'Super Member',
  admin: 'Administrator',
};

const AGGRESSIVENESS_OPTIONS: Array<{ value: ProfileStrategy['aggressiveness']; label: string; hint: string }> = [
  { value: 'safe',       label: 'Safe',       hint: 'Higher confidence floor, lower beta tolerance, stricter GPS gate (~5% above baseline)' },
  { value: 'neutral',    label: 'Neutral',    hint: 'Default thresholds (baseline)' },
  { value: 'aggressive', label: 'Aggressive', hint: 'Lower thresholds — surfaces higher-volatility picks (~5% below baseline)' },
];

const TIMEFRAME_OPTIONS: Array<{ value: ProfileStrategy['investment_timeframe']; label: string; hint: string }> = [
  { value: '1_week',  label: '1 Week',  hint: 'Hair-trigger predictions, lower upside bar; ML gate ≥ 0.5%' },
  { value: '1_month', label: '1 Month', hint: 'Default horizon (baseline); ML gate ≥ 1.5%' },
  { value: '3_month', label: '3 Month', hint: 'Medium horizon; holds through short-term noise; ML gate ≥ 3%' },
  { value: '6_month', label: '6 Month', hint: 'Holds through dips, requires larger upside; ML gate ≥ 5%' },
];

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: ProfileResponse };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

export default function Profile() {
  const [state, setState] = useState<FetchState>({ status: 'loading' });
  const [strategy, setStrategy] = useState<ProfileStrategy | null>(null);
  const [originalStrategy, setOriginalStrategy] = useState<ProfileStrategy | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });

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
        if (!cancelled) {
          setState({ status: 'success', data });
          setStrategy(data.strategy);
          setOriginalStrategy(data.strategy);
        }
      } catch (err: any) {
        if (!cancelled) setState({ status: 'error', message: err.message ?? 'Failed to load profile' });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const isDirty = strategy && originalStrategy &&
    strategy.aggressiveness !== originalStrategy.aggressiveness;

  // Used by the aggressiveness card (Save button).
  async function handleSave() {
    if (!strategy) return;
    setSaveState({ status: 'saving' });
    try {
      const res = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.message ?? `Server error (${res.status})`);
      }
      setOriginalStrategy(strategy);
      setSaveState({ status: 'saved' });
      setTimeout(() => setSaveState({ status: 'idle' }), 2500);
    } catch (err: any) {
      setSaveState({ status: 'error', message: err.message ?? 'Failed to save' });
    }
  }

  // Used by the timeframe pill card (optimistic save).
  async function handleTimeframeChange(next: ProfileStrategy['investment_timeframe']) {
    if (!strategy || strategy.investment_timeframe === next) return;
    // Optimistic: update local state immediately, revert on failure.
    const previous = strategy;
    setStrategy({ ...strategy, investment_timeframe: next });
    try {
      const res = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ investment_timeframe: next }),
      });
      if (!res.ok) throw new Error('Save failed');
      setOriginalStrategy(s => s ? { ...s, investment_timeframe: next } : s);
    } catch {
      setStrategy(previous);
    }
  }

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

      {/* Investment Strategy card */}
      {strategy && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6 section-investment-strategy">
          <h2 className="section-heading">Investment Strategy</h2>
          <p className="text-sm text-gray-600 mb-4">
            Tune how recommendations and GPS scoring are weighted for your account.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StrategySelect
              label="Aggressiveness"
              value={strategy.aggressiveness}
              options={AGGRESSIVENESS_OPTIONS}
              onChange={v => setStrategy({ ...strategy, aggressiveness: v as ProfileStrategy['aggressiveness'] })}
            />
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={!isDirty || saveState.status === 'saving'}
              className="px-4 py-2 rounded-lg bg-[#017e3b] text-white text-sm font-semibold hover:bg-[#016330] disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {saveState.status === 'saving' ? 'Saving…' : 'Save Strategy'}
            </button>
            {saveState.status === 'saved' && (
              <span className="text-sm text-green-700 font-medium">Saved.</span>
            )}
            {saveState.status === 'error' && (
              <span className="text-sm text-red-600">{saveState.message}</span>
            )}
          </div>
        </div>
      )}

      {/* Investment Timeframe card */}
      {strategy && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6 section-investment-timeframe">
          <h2 className="section-heading">Investment Timeframe</h2>
          <p className="text-sm text-gray-600 mb-4">
            How far out should predictions look? Tightens or loosens the predicted-change bar
            and the DeepMoney ML validation gate.
          </p>

          <div className="flex flex-wrap gap-2">
            {TIMEFRAME_OPTIONS.map(option => {
              const active = strategy.investment_timeframe === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => handleTimeframeChange(option.value)}
                  aria-pressed={active}
                  className={`px-4 py-2 rounded-full text-sm font-semibold border transition-colors ${
                    active
                      ? 'bg-[#017e3b] text-white border-[#017e3b]'
                      : 'bg-white text-gray-700 border-gray-300 hover:border-[#017e3b] hover:text-[#017e3b]'
                  }`}
                >
                  {option.label}
                  {active && <span className="ml-1.5" aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>

          <p className="mt-3 text-xs text-gray-500">
            {TIMEFRAME_OPTIONS.find(o => o.value === strategy.investment_timeframe)?.hint}
          </p>
        </div>
      )}

      {/* Stats — only for user / superuser */}
      {data.accountType !== 'admin' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 section-activity-summary">
          <h2 className="section-heading">Activity Summary</h2>
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

function StrategySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; hint: string }>;
  onChange: (v: string) => void;
}) {
  const selected = options.find(o => o.value === value);
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-[#017e3b] focus:border-transparent"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {selected && (
        <p className="mt-1 text-xs text-gray-500">{selected.hint}</p>
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
