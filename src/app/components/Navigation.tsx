'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function Navigation() {
  const pathname = usePathname()

  return (
    <nav className="bg-gradient-to-r from-blue-600 to-indigo-600 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            <h1 className="text-2xl font-bold text-white">Money Go Up</h1>
          </div>
          <div className="flex space-x-8">
            <Link href="/" legacyBehavior>
              <a
                className={`px-4 py-2 rounded-lg font-semibold transition duration-200 ${
                  pathname === '/'
                    ? 'bg-white text-blue-600 shadow-lg'
                    : 'text-white hover:bg-blue-500'
                }`}
              >
                Dashboard
              </a>
            </Link>
            <Link href="/search" legacyBehavior>
              <a
                className={`px-4 py-2 rounded-lg font-semibold transition duration-200 ${
                  pathname === '/search'
                    ? 'bg-white text-blue-600 shadow-lg'
                    : 'text-white hover:bg-blue-500'
                }`}
              >
                Search
              </a>
            </Link>
          </div>
        </div>
      </div>
    </nav>
  )
}
