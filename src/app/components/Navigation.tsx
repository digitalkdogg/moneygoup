'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react' // Import signOut and useSession

export default function Navigation() {
  const pathname = usePathname()
  const { data: session } = useSession(); // Get session data

  return (
    <nav className="bg-green-700 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            <h1 className="text-2xl font-bold text-white">Money Go Up</h1>
          </div>
          <div className="flex space-x-8">
            <Link href="/" className={`px-4 py-2 rounded-lg font-semibold transition duration-200 ${
              pathname === '/'
                ? 'bg-white text-green-700 shadow-lg'
                : 'text-white hover:bg-green-800'
            }`}>
              
                Dashboard
              
            </Link>
            <Link href="/search" className={`px-4 py-2 rounded-lg font-semibold transition duration-200 ${
              pathname === '/search'
                ? 'bg-white text-green-700 shadow-lg'
                : 'text-white hover:bg-green-800'
            }`}>
              
                Search
              
            </Link>
            {session && ( // Conditionally render Logout button if session exists
              <button
                onClick={() => signOut({ callbackUrl: 'http://localhost:3001/login' })} // Redirect to login after logout
                className="px-4 py-2 rounded-lg font-semibold transition duration-200 text-white hover:bg-green-800 cursor-pointer"
              >
                Logout
              </button>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
