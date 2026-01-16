import Stock from "@/app/components/Stock";

export default function StockPage({ params, searchParams }: { params: { ticker: string }; searchParams: { source?: string } }) {
  const { ticker } = params;
  const source = searchParams?.source;
  
  return (
    <div>
        <Stock ticker={ticker} source={source} />
    </div>
  );
}
