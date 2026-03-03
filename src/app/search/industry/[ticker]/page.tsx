import IndustryStocks from '@/app/components/IndustryStocks';

export default function IndustrySearchPage({ params }: { params: { ticker: string } }) {
  return (
    <main className="min-h-screen bg-gray-50 pb-12">
      <IndustryStocks ticker={params.ticker} />
    </main>
  );
}
