import IndustryStocks from '@/app/components/IndustryStocks';

export default async function IndustrySearchPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  return (
    <main className="min-h-screen bg-gray-50 pb-12">
      <IndustryStocks ticker={ticker} />
    </main>
  );
}
