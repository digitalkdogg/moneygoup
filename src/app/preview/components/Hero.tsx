export default function Hero() {
  return (
    <section className="relative w-full bg-gradient-to-br from-green-600 via-green-500 to-emerald-600 text-white overflow-hidden">
      {/* Decorative background elements */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-green-400 rounded-full opacity-20 blur-3xl"></div>
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-emerald-400 rounded-full opacity-20 blur-3xl"></div>
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 sm:py-24 lg:py-32">
        {/* Site Title */}
        <div className="text-center mb-8 sm:mb-12">
          <p className="text-lg sm:text-xl font-semibold tracking-wide">GrowMyStock</p>
        </div>

        <div className="text-center space-y-6 sm:space-y-8">
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight">
            AI-Powered Stock Analysis
            <span className="block text-indigo-100">Reimagined for You</span>
          </h1>

          <p className="max-w-2xl mx-auto text-lg sm:text-xl text-indigo-100">
            Get intelligent stock insights, deep market analysis, and AI-driven predictions.
            Join our growing community of smart investors.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-4">
            <a
              href="#contact"
              className="inline-block bg-white text-green-600 font-semibold px-8 py-4 rounded-lg hover:bg-green-50 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-white min-h-12 flex items-center justify-center"
              aria-label="Get early access to GrowMyStock"
            >
              Get Early Access
            </a>
            <a
              href="#features"
              className="inline-block border-2 border-white text-white font-semibold px-8 py-4 rounded-lg hover:bg-white hover:text-green-600 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-white min-h-12 flex items-center justify-center"
              aria-label="Learn more about GrowMyStock features"
            >
              Learn More
            </a>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-6 sm:gap-12 mt-16 sm:mt-20 max-w-3xl mx-auto">
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold">50K+</div>
            <p className="text-indigo-100 text-sm sm:text-base">Stocks Tracked</p>
          </div>
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold">24/7</div>
            <p className="text-indigo-100 text-sm sm:text-base">Market Analysis</p>
          </div>
          <div className="text-center">
            <div className="text-3xl sm:text-4xl font-bold">AI</div>
            <p className="text-indigo-100 text-sm sm:text-base">Powered Insights</p>
          </div>
        </div>
      </div>
    </section>
  );
}
