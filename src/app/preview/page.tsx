import { Metadata } from 'next';
import Hero from './components/Hero';
import Features from './components/Features';
import CTA from './components/CTA';
import ContactForm from './components/ContactForm';
import Footer from './components/Footer';
import PreviewVisitLogger from './components/PreviewVisitLogger';

export const metadata: Metadata = {
  title: 'GrowMyStock Preview - AI-Powered Stock Analysis',
  description: 'Get early access to GrowMyStock. AI-driven stock analysis, real-time market data, and intelligent investment insights for smarter trading decisions.',
  keywords: [
    'stock analysis',
    'AI investing',
    'stock prediction',
    'market analysis',
    'portfolio tracking',
    'investment insights',
  ],
  openGraph: {
    title: 'GrowMyStock - AI-Powered Stock Analysis',
    description: 'Get early access to AI-driven stock analysis and intelligent investment insights.',
    type: 'website',
    url: 'https://growmystock.com/preview',
    siteName: 'GrowMyStock',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'GrowMyStock Platform',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GrowMyStock - AI-Powered Stock Analysis',
    description: 'Get early access to AI-driven stock analysis and intelligent investment insights.',
    images: ['/og-image.png'],
  },
  robots: 'index, follow',
};

export default function PreviewPage() {
  return (
    <main className="w-full bg-white" id="main-content">
      <PreviewVisitLogger />
      <Hero />
      <Features />
      <CTA />
      <ContactForm />
      <Footer />
    </main>
  );
}
