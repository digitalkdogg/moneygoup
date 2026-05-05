interface FeatureCard {
  title: string;
  description: string;
  icon: string;
}

const features: FeatureCard[] = [
  {
    title: 'AI-Driven Predictions',
    description: 'Advanced machine learning models analyze market trends and predict stock movements with unprecedented accuracy.',
    icon: '🤖',
  },
  {
    title: 'Real-Time Market Data',
    description: 'Stay ahead with live stock quotes, news feeds, and market indicators updated throughout the trading day.',
    icon: '📊',
  },
  {
    title: 'Deep Fundamental Analysis',
    description: 'Comprehensive earnings reports, analyst ratings, and company metrics at your fingertips.',
    icon: '📈',
  },
  {
    title: 'Portfolio Tracking',
    description: 'Monitor your investments, track performance, and get personalized recommendations.',
    icon: '💼',
  },
  {
    title: 'Industry Insights',
    description: 'Understand sector trends and competitive dynamics to make informed investment decisions.',
    icon: '🏭',
  },
  {
    title: 'Watchlist Management',
    description: 'Create custom watchlists, set price alerts, and never miss investment opportunities.',
    icon: '👁️',
  },
];

export default function Features() {
  return (
    <section id="features" className="w-full py-20 sm:py-24 lg:py-32 px-4 sm:px-6 lg:px-8 bg-gray-50">
      <div className="max-w-6xl mx-auto">
        <div className="text-center space-y-4 mb-16 sm:mb-20">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900">
            Powerful Features for Smart Investors
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Everything you need to make confident investment decisions, all in one platform.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <article
              key={index}
              className="bg-white rounded-lg shadow-md p-8 hover:shadow-lg transition-shadow focus-within:ring-2 focus-within:ring-green-500 focus-within:ring-offset-2"
            >
              <div className="text-4xl mb-4" aria-hidden="true">{feature.icon}</div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                {feature.title}
              </h3>
              <p className="text-gray-600 leading-relaxed">
                {feature.description}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
