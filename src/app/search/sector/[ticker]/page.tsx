import SectorStocks from '@/app/components/SectorStocks';

export default function SectorSearchPage({ params }: { params: { ticker: string } }) {
  return (
    <main className="min-h-screen bg-gray-50 pb-12">
      <SectorStocks ticker={params.ticker} />
    </main>
  );
}
