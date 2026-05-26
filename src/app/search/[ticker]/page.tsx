import Stock from "@/app/components/Stock";

export default async function StockPage({ params, searchParams }: { params: Promise<{ ticker: string }>; searchParams: Promise<{ source?: string }> }) {
  const { ticker: lowerCaseTicker } = await params;
  const ticker = lowerCaseTicker.toUpperCase();
  const { source } = await searchParams;

  return (
    <main id="main-content">
        <Stock ticker={ticker} source={source} />
    </main>
  );
}
