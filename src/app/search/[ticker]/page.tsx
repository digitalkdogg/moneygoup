
import Stock from "@/app/components/Stock";

export default async function StockPage({ params }: { params: { ticker: string } }) {
  return (
    <div>
        <Stock ticker={params.ticker} />
    </div>
  );
}
