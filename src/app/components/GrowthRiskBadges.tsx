'use client';

import React from 'react';
import type { StockClassification } from '@/utils/stockClassifier';

const GROWTH_TIPS: Record<number, string> = {
  1: 'Almost no growth potential — revenue flat or declining, weak analyst targets, model sees minimal upside.',
  2: 'Below-average growth — limited upside expected. May suit capital preservation or income-focused investors.',
  3: 'Modest growth signals — some positive indicators but not enough to stand out.',
  4: 'Solid growth signals — revenue expanding, analysts bullish, model predicts meaningful price appreciation.',
  5: 'Exceptional growth potential — strong momentum across all indicators. High-conviction buy signal.',
};

const GROWTH_LABELS: Record<number, string> = {
  1: 'Minimal growth',
  2: 'Below-average',
  3: 'Modest growth',
  4: 'Solid growth',
  5: 'Exceptional',
};

const RISK_TIPS: Record<number, string> = {
  1: 'Very safe — stable fundamentals, reasonable valuation, no major warning signals.',
  2: 'Low risk — minor concerns but nothing alarming. Suitable for most portfolios.',
  3: 'Moderate risk — some valuation or signal concerns, but typical for a healthy mid-cap or large-cap.',
  4: 'High risk — stretched valuation, weakening signal, or earnings uncertainty. Position sizing matters here.',
  5: 'Speculative — significant risk across multiple fronts. High potential reward, but equally high potential loss.',
};

const RISK_LABELS: Record<number, string> = {
  1: 'Very safe',
  2: 'Low risk',
  3: 'Moderate risk',
  4: 'High risk',
  5: 'Speculative',
};

function riskColor(stars: number): string {
  if (stars <= 2) return '#16a34a';
  if (stars === 3) return '#d97706';
  return '#dc2626';
}

function PipBar({ filled, filledColor }: { filled: number; filledColor: string }) {
  return (
    <span className="flex gap-1">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            width: '14px',
            height: '6px',
            borderRadius: '2px',
            backgroundColor: i < filled ? filledColor : '#e5e7eb',
          }}
        />
      ))}
    </span>
  );
}

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="relative group/tip inline-flex">
      {children}
      <span className="
        pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50
        w-56 rounded-lg bg-gray-900 text-white text-[11px] leading-snug px-3 py-2 shadow-lg
        opacity-0 group-hover/tip:opacity-100 transition-opacity duration-150
      ">
        {text}
        <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
      </span>
    </span>
  );
}

export default function GrowthRiskBadges({ classification }: { classification: StockClassification }) {
  const rc = riskColor(classification.riskStars);
  return (
    <div className="flex flex-col gap-1.5">
      <Tooltip text={GROWTH_TIPS[classification.growthStars] ?? ''}>
        <div className="flex items-center gap-3 cursor-default">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wide w-12">Growth</span>
          <PipBar filled={classification.growthStars} filledColor="#16a34a" />
          <span className="text-xs text-gray-600">{GROWTH_LABELS[classification.growthStars] ?? ''}</span>
        </div>
      </Tooltip>
      <Tooltip text={RISK_TIPS[classification.riskStars] ?? ''}>
        <div className="flex items-center gap-3 cursor-default">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wide w-12">Risk</span>
          <PipBar filled={classification.riskStars} filledColor={rc} />
          <span className="text-xs font-medium" style={{ color: rc }}>{RISK_LABELS[classification.riskStars] ?? ''}</span>
        </div>
      </Tooltip>
    </div>
  );
}
