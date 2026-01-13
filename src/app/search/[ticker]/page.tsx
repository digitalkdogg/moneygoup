
import Stock from "@/app/components/Stock";

export default function StockPage({ params }: { params: { ticker: string } }) {
  return (
    <div>
        <Stock ticker={params.ticker} />
    </div>
  );
}
