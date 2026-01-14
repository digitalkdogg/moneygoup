
import Stock from "@/app/components/Stock";
import { use } from "react";

export default function StockPage({ params }: { params: Promise<{ ticker: string }> }) {
  const resolvedParams = use(params);
  return (
    <div>
        <Stock ticker={resolvedParams.ticker} />
    </div>
  );
}
