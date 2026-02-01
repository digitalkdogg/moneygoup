import Stock from "@/app/components/Stock";

export default function StockPage({ params, searchParams }: { params: { ticker: string }; searchParams: { source?: string } }) {
  const { ticker: lowerCaseTicker } = params;
  const ticker = lowerCaseTicker.toUpperCase();
  const source = searchParams?.source;
  
  return (
    <div>
        <Stock ticker={ticker} source={source} />
    </div>
  );
}
