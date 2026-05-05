export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="w-full bg-gray-900 text-gray-300 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-8">
          {/* Brand */}
          <div>
            <h3 className="text-white font-bold text-lg mb-2">GrowMyStock</h3>
            <p className="text-sm text-gray-400">
              AI-powered stock analysis for smarter investing decisions.
            </p>
          </div>

          {/* Links */}
          <nav aria-label="Product navigation">
            <h4 className="text-white font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <a href="#features" className="hover:text-white focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-gray-900 rounded px-1 transition-colors">
                  Features
                </a>
              </li>
              <li>
                <a href="#contact" className="hover:text-white focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-gray-900 rounded px-1 transition-colors">
                  Get Access
                </a>
              </li>
            </ul>
          </nav>

          {/* Legal */}
          <nav aria-label="Legal navigation">
            <h4 className="text-white font-semibold mb-4">Legal</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <a href="/privacy" className="hover:text-white focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-gray-900 rounded px-1 transition-colors">
                  Privacy Policy
                </a>
              </li>
              <li>
                <a href="/terms" className="hover:text-white focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-gray-900 rounded px-1 transition-colors">
                  Terms of Service
                </a>
              </li>
            </ul>
          </nav>
        </div>

        <div className="border-t border-gray-800 pt-8">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-gray-400">
            <p>
              © {currentYear} GrowMyStock. All rights reserved.
            </p>
            <div className="flex gap-6">
              <a href="#" className="hover:text-white focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-gray-900 rounded px-1 transition-colors" aria-label="Visit GrowMyStock on Twitter">
                Twitter
              </a>
              <a href="#" className="hover:text-white focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-gray-900 rounded px-1 transition-colors" aria-label="Visit GrowMyStock on LinkedIn">
                LinkedIn
              </a>
              <a href="#" className="hover:text-white focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-gray-900 rounded px-1 transition-colors" aria-label="Visit GrowMyStock on GitHub">
                GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
