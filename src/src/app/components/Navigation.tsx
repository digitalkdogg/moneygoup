'use client'

import { useState, useRef, useEffect } from 'react' // Import useState, useRef, useEffect
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react' // Import signOut and useSession

export default function Navigation() {
  const pathname = usePathname()
  const { data: session } = useSession(); // Get session data
  const [isMenuOpen, setIsMenuOpen] = useState(false); // State to control dropdown visibility
  const menuRef = useRef<HTMLDivElement>(null); // Ref for the dropdown menu

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [menuRef]);

  return (
    <nav className="bg-green-700 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            <h1 className="text-2xl font-bold text-white">Money Go Up</h1>
          </div>
          <div className="flex items-center space-x-4"> {/* Use space-x-4 for spacing between elements */}
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
            {session?.user?.name && (
              <div className="relative">
                <button
                  onClick={() => setIsMenuOpen(!isMenuOpen)}
                  className="flex items-center justify-center h-9 w-9 rounded-full bg-green-800 text-white font-bold text-sm cursor-pointer focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-600"
                >
                  {session.user.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2)}
                </button>

                {isMenuOpen && (
                  <div ref={menuRef} className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg py-1 z-50 ring-1 ring-black ring-opacity-5 focus:outline-none">
                    <div className="px-4 py-2 text-sm text-gray-700 border-b border-gray-200">
                      {session.user.name}
                    </div>
                    <button
                      onClick={() => signOut({ callbackUrl: 'http://localhost:3001/login' })}
                      className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer"
                    >
                      Logout
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
