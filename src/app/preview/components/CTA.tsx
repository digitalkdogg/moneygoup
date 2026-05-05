export default function CTA() {
  return (
    <section className="w-full py-16 sm:py-20 lg:py-24 px-4 sm:px-6 lg:px-8 bg-gradient-to-r from-green-600 to-emerald-600 text-white">
      <div className="max-w-4xl mx-auto text-center space-y-8">
        <div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-4">
            Ready to Transform Your Investing?
          </h2>
          <p className="text-lg sm:text-xl text-indigo-100">
            Join our waitlist and get exclusive early access to GrowMyStock's AI-powered platform.
            Be among the first to experience smarter investing.
          </p>
        </div>

        <div className="pt-4">
          <a
            href="#contact"
            className="inline-block bg-white text-green-600 font-semibold px-10 py-4 rounded-lg hover:bg-green-50 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-green-600 focus:ring-white text-lg min-h-12 flex items-center justify-center"
            aria-label="Jump to contact form to request early access"
          >
            Request Early Access
          </a>
        </div>

        <p className="text-sm text-indigo-100 pt-4">
          No credit card required. We'll email you when your spot is ready.
        </p>
      </div>
    </section>
  );
}
