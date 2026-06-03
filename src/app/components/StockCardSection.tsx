// src/app/components/StockCardSection.tsx
'use client';

import { ReactNode } from 'react';

interface StockCardSectionProps<T> {
  title: string;
  icon?: string;
  data: T[];
  renderCard: (item: T, index: number) => ReactNode;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: ReactNode;
  columns?: 2 | 3 | 4;
}

export default function StockCardSection<T>({
  title,
  icon,
  data,
  renderCard,
  loading = false,
  error = null,
  emptyMessage = <span>No data found.</span>,
  columns = 3,
}: StockCardSectionProps<T>) {
  const gridClass = columns === 4
    ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
    : columns === 2
    ? 'grid grid-cols-1 md:grid-cols-2'
    : 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
  return (
    <section className="mb-8">
      <h2 className="section-heading">{title}</h2>

      {loading && data.length === 0 && (
        <div className="py-12 text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-green-600 border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]" role="status">
            <span className="!absolute !-m-px !h-px !w-px !overflow-hidden !whitespace-nowrap !border-0 !p-0 ![clip:rect(0,0,0,0)]">Loading...</span>
          </div>
          <p className="text-gray-600 mt-4 font-medium">Loading {title.toLowerCase()}...</p>
        </div>
      )}

      {error && data.length === 0 && (
        <div className="py-12 text-center">
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 inline-block">
            <p className="text-red-600 font-semibold">{error}</p>
          </div>
        </div>
      )}

      {data.length > 0 ? (
        <div className={`${gridClass} gap-6 auto-rows-max`}>
          {data.map((item, index) => (
            <div
              key={(item as any).symbol || (item as any).id || index}
              style={{
                animation: `slideUp 0.4s ease-out ${index * 0.05}s backwards`,
              }}
            >
              {renderCard(item, index)}
            </div>
          ))}
        </div>
      ) : (
        !loading && !error && (
          <div className="py-16 text-center bg-gray-50 rounded-xl border-2 border-dashed border-gray-200">
            <p className="text-gray-500 font-medium px-4">{emptyMessage}</p>
          </div>
        )
      )}

      <style>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </section>
  );
}
