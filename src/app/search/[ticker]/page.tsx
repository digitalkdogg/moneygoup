
import Stock from "@/app/components/Stock";
import { use } from "react";

export default function StockPage({ params, searchParams }: { params: Promise<{ ticker: string }>; searchParams: Promise<{ source?: string }> }) {
  const resolvedParams = use(params);
  const resolvedSearchParams = use(searchParams);
  const source = resolvedSearchParams.source;
  return (
    <div>
        <Stock ticker={resolvedParams.ticker} source={source} />
    </div>
  );
}
