'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'
import Image from 'next/image'

export default function Navigation() {
  const pathname = usePathname()
  const { data: session } = useSession();
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  // Close profile dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [profileRef]);

  // Prevent scrolling when mobile menu is open
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
  }, [isMobileMenuOpen]);

  const initials = (session?.user?.name ?? '')
    .trim()
    .split(/\s+/)
    .map(n => n[0] ?? '')
    .filter(c => /[A-Za-z0-9]/.test(c))
    .join('')
    .toUpperCase()
    .substring(0, 2)
    || '?';

  const NavLinks = ({ mobile = false }) => (
    <>
      <Link 
        href="/" 
        onClick={() => setIsMobileMenuOpen(false)}
        className={`px-4 py-3 md:py-2 rounded-lg font-semibold transition duration-200 flex items-center justify-between ${
          pathname === '/'
            ? mobile ? 'bg-green-800 text-white' : 'bg-white text-green-700 shadow-lg'
            : 'text-white hover:bg-green-800'
        } ${mobile ? 'w-full text-lg h-[56px]' : ''}`}
      >
        <span>Dashboard</span>
        {mobile && <span className="text-xl">›</span>}
      </Link>
      <Link 
        href="/search" 
        onClick={() => setIsMobileMenuOpen(false)}
        className={`px-4 py-3 md:py-2 rounded-lg font-semibold transition duration-200 flex items-center justify-between ${
          pathname === '/search'
            ? mobile ? 'bg-green-800 text-white' : 'bg-white text-green-700 shadow-lg'
            : 'text-white hover:bg-green-800'
        } ${mobile ? 'w-full text-lg h-[56px]' : ''}`}
      >
        <span>Deepmoney Search</span>
        {mobile && <span className="text-xl">›</span>}
      </Link>
    </>
  );

  return (
    <>
      <nav style={{ backgroundColor: '#029b37' }} className="shadow-lg sticky top-0 z-40 w-full">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <Link href="/" className="flex items-center gap-2 text-2xl font-bold text-white">
                <Image
                  src="/growmystock_logo.svg"
                  alt="Grow My Stock logo"
                  width={35}
                  height={35}
                  priority
                />
                <span aria-hidden="true">
                  Grow
                  <span style={{ color: '#09522b', fontWeight: 'bold', fontSize: '1.1em', marginRight: '1px', marginLeft:'3px'}}>
                    MY
                  </span>
                  <span >Stock</span>
                </span>
              </Link>
            </div>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center space-x-4">
              <NavLinks />
              {session?.user?.name && (
                <div className="relative" ref={profileRef}>
                  <button
                    onClick={() => setIsProfileOpen(!isProfileOpen)}
                    style={{ backgroundColor: '#016630' }}
                    className="flex items-center justify-center h-9 w-9 rounded-full text-white font-bold text-sm cursor-pointer focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-600"
                  >
                    {initials}
                  </button>

                  {isProfileOpen && (
                    <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg py-1 z-50 ring-1 ring-black ring-opacity-5 focus:outline-none">
                      <div className="px-4 py-2 text-sm text-gray-700 border-b border-gray-200">
                        {session.user.name}
                      </div>
                      <button
                        onClick={() => signOut({ callbackUrl: `${process.env.NEXT_PUBLIC_NEXTAUTH_URL || ''}/login` })}
                        className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer"
                      >
                        Logout
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Mobile Hamburger Button */}
            <div className="flex md:hidden items-center">
              <button
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                className="inline-flex items-center justify-center p-2 rounded-md text-white hover:bg-green-800 focus:outline-none w-[44px] h-[44px]"
                aria-expanded="false"
              >
                <span className="sr-only">Open main menu</span>
                {isMobileMenuOpen ? (
                  <svg className="block h-8 w-8 transition-transform duration-150 ease-in-out" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="block h-8 w-8 transition-transform duration-150 ease-in-out" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Mobile Menu Drawer */}
      <div 
        className={`fixed inset-0 z-50 md:hidden transition-opacity duration-300 ${isMobileMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
      >
        {/* Scrim Overlay */}
        <div 
          className="absolute inset-0 bg-white bg-opacity-50 opacity-70"
          onClick={() => setIsMobileMenuOpen(false)}
        />
        
        {/* Drawer Content */}
        <div 
          style={{ backgroundColor: '#029b37' }}
          className={`absolute top-0 right-0 h-full w-[80%] max-w-[320px] shadow-xl transition-transform duration-200 ease-out transform ${isMobileMenuOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
          <div className="flex flex-col h-full pt-5 pb-6">
            <div className="px-5 mb-8 flex justify-between items-center">
              <span className="text-xl font-bold text-white">Grow<span style={{ color: '#034622', fontWeight: 'bold' }}>My</span>Stock</span>
              <button 
                onClick={() => setIsMobileMenuOpen(false)}
                className="text-white p-2 w-[44px] h-[44px] flex items-center justify-center"
              >
                <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {session?.user && (
              <div className="px-5 mb-6 flex items-center space-x-3">
                <div 
                  style={{ backgroundColor: '#016630' }}
                  className="h-12 w-12 rounded-full flex items-center justify-center text-white font-bold border-2 border-white/20"
                >
                  {initials}
                </div>
                <div className="text-white">
                  <p className="text-sm opacity-80 font-medium">Hi,</p>
                  <p className="text-lg font-bold leading-tight">{session.user.name}</p>
                </div>
              </div>
            )}

            <div className="flex-1 px-2 space-y-1">
              <NavLinks mobile={true} />
            </div>

            <div className="px-5 mt-auto pt-6 border-t border-white/20">
              <button
                onClick={() => signOut({ callbackUrl: `${process.env.NEXT_PUBLIC_NEXTAUTH_URL || ''}/login` })}
                className="flex items-center space-x-2 text-white opacity-80 hover:opacity-100 py-3 w-full text-left"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1h3v-3H7" />
                </svg>
                <span className="font-medium">Log Out</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
