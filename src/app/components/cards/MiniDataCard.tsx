'use client';

import React from 'react';

export type MiniDataCardTone = 'positive' | 'negative' | 'neutral';

interface MiniDataCardProps {
  label: string;
  badge?: string;
  primaryText: string;
  secondaryText: string | React.ReactNode;
  tone?: MiniDataCardTone;
  subLabel?: React.ReactNode;
  primaryClassOverride?: string;
}

const MiniDataCard: React.FC<MiniDataCardProps> = ({
  label,
  badge,
  primaryText,
  secondaryText,
  tone = 'neutral',
  subLabel,
  primaryClassOverride = 'text-sm font-extrabold text-gray-900 leading-tight mb-0.5'
}) => {
  const toneClasses = {
    positive: 'text-green-600',
    negative: 'text-red-600',
    neutral: 'text-gray-600',
  };

  const badgeClasses = {
    positive: 'text-green-700 border-green-200 border',
    negative: 'bg-red-100 text-red-700 border-red-200',
    neutral: 'bg-gray-100 text-gray-700 border-gray-200',
  };

  const badgeStyle = tone === 'positive' ? { backgroundColor: '#a8d78d' } : {};
  const badgeToneClass = tone === 'positive' ? badgeClasses.positive : tone === 'negative' ? badgeClasses.negative : badgeClasses.neutral;
  const secondaryToneClass = tone === 'positive' ? toneClasses.positive : tone === 'negative' ? toneClasses.negative : toneClasses.neutral;

  return (
    <div className="border border-gray-100 bg-gray-50 rounded-lg p-3 hover:border-gray-200 transition-colors">
      <div className="flex justify-between items-start mb-1">
        <div className="text-[10px] uppercase font-bold text-gray-500 tracking-wider overflow-hidden text-ellipsis whitespace-nowrap mr-2">
          {label}
        </div>
        {badge && (
          <span style={badgeStyle} className={`text-[9px] font-black px-1.5 py-0.5 rounded border uppercase leading-tight shrink-0 ${badgeToneClass}`}>
            {badge}
          </span>
        )}
      </div>
      
      <div className="flex flex-col">
        <span className={primaryClassOverride}>
          {primaryText}
        </span>
        <span className={`text-[11px] font-bold ${secondaryToneClass}`}>
          {secondaryText}
        </span>
        {subLabel && (
          <span className="text-[9px] text-gray-400 mt-1 font-medium italic">
            {subLabel}
          </span>
        )}
      </div>
    </div>
  );
};

export default MiniDataCard;
