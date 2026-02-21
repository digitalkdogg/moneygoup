// src/app/components/StockTable.tsx
'use client';

import { ReactNode } from 'react';

export interface StockTableRow {
  symbol: string;
  name?: string;
  regularMarketPrice: number;
  marketCap?: number | null;
  metric?: string | number;
  metricLabel?: string;
  [key: string]: any;
}

interface StockTableProps<T extends StockTableRow> {
  title: string;
  icon?: string;
  data: T[];
  columns: Array<{
    key: keyof T | string;
    label: string;
    align?: 'left' | 'center' | 'right';
    format?: (value: any, row: T) => ReactNode;
  }>;
  onRowClick?: (symbol: string) => void;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
}

export default function StockTable<T extends StockTableRow>({
  title,
  icon,
  data,
  columns,
  onRowClick,
  loading = false,
  error = null,
  emptyMessage = 'No data found.',
}: StockTableProps<T>) {
  const handleRowClick = (symbol: string) => {
    if (onRowClick) {
      onRowClick(symbol);
    }
  };

  return (
    <section className="bg-white p-6 rounded-2xl shadow-lg mb-8" id = "table">
      <h2 className="text-2xl font-bold text-gray-800 mb-4 text-center">
        {icon && <span className="mr-2">{icon}</span>}
        {title}
      </h2>

      {loading && data.length === 0 && (
        <p className="text-gray-600 text-center">Loading {title.toLowerCase()}...</p>
      )}

      {error && data.length === 0 && (
        <p className="text-red-500 text-sm mb-4 text-center">{error}</p>
      )}

      {data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {columns.map((column) => (
                  <th
                    key={String(column.key)}
                    scope="col"
                    className={`px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider ${
                      column.align === 'right'
                        ? 'text-right'
                        : column.align === 'center'
                        ? 'text-center'
                        : 'text-left'
                    }`}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data.map((row) => (
                <tr
                  key={row.symbol}
                  onClick={() => handleRowClick(row.symbol)}
                  className="hover:bg-gray-50 cursor-pointer group transition-colors"
                >
                  {columns.map((column) => {
                    const value = row[column.key as keyof T];
                    const displayValue = column.format ? column.format(value, row) : value;

                    return (
                      <td
                        key={String(column.key)}
                        className={`px-6 py-4 whitespace-nowrap text-sm ${
                          column.align === 'right'
                            ? 'text-right'
                            : column.align === 'center'
                            ? 'text-center'
                            : 'text-left'
                        }`}
                      >
                        {column.key === 'symbol' ? (
                          <span className="font-medium text-gray-900">{displayValue}</span>
                        ) : column.key === 'metric' ? (
                          <span className="text-gray-500">{displayValue}</span>
                        ) : (
                          <span className="text-gray-500">{displayValue}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !loading && !error && <p className="text-gray-600 text-center">{emptyMessage}</p>
      )}
    </section>
  );
}
