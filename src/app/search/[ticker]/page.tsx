import Stock from "@/app/components/Stock";

export default function StockPage({ params, searchParams }: { params: { ticker: string }; searchParams: { source?: string } }) {
  const { ticker: lowerCaseTicker } = params;
  const ticker = lowerCaseTicker.toUpperCase();
  const source = searchParams?.source;
  
  return (
    <main id="main-content">
        <Stock ticker={ticker} source={source} />
    </main>
  );
}
