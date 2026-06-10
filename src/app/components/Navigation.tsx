'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'
import Image from 'next/image'

export default function Navigation() {
  const pathname = usePathname()

  // Hide navigation on preview page
  if (pathname === '/preview') {
    return null;
  }

  const { data: session } = useSession();
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  // Default true so the link is visible until we confirm the portfolio is empty
  const [hasPortfolio, setHasPortfolio] = useState(true);

  useEffect(() => {
    if (!session?.user?.id) return;
    fetch('/api/user/profile')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        // stats is absent for admin accounts — leave the default true in that case
        if (data?.stats) {
          setHasPortfolio(data.stats.portfolioItemCount > 0);
        }
      })
      .catch(() => {});
  }, [session?.user?.id]);
  const profileRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);

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

  // Accessibility: Focus trap, focus return and Escape to close for mobile menu
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
      
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setIsMobileMenuOpen(false);
      };

      const handleFocusTrap = (e: KeyboardEvent) => {
        if (e.key !== 'Tab' || !mobileMenuRef.current) return;
        
        const focusableElements = mobileMenuRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstElement = focusableElements[0] as HTMLElement;
        const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            lastElement.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === lastElement) {
            firstElement.focus();
            e.preventDefault();
          }
        }
      };

      document.addEventListener('keydown', handleEscape);
      document.addEventListener('keydown', handleFocusTrap);
      
      // Focus first element in menu
      const firstFocusable = mobileMenuRef.current?.querySelectorAll('button, [href]')[0] as HTMLElement;
      firstFocusable?.focus();

      return () => {
        document.removeEventListener('keydown', handleEscape);
        document.removeEventListener('keydown', handleFocusTrap);
        document.body.style.overflow = 'unset';
        // Return focus to trigger
        mobileTriggerRef.current?.focus();
      };
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
        aria-current={pathname === '/' ? 'page' : undefined}
        className={`md:px-2 lg:px-4 px-4 py-3 md:py-2 rounded-lg font-medium transition duration-200 flex items-center justify-between border-2 ${
          pathname === '/'
            ? mobile 
              ? 'bg-green-800 text-white border-white/40' 
              : 'bg-white text-green-700 shadow-lg border-white'
            : 'text-white border-transparent hover:bg-green-800 hover:border-white/20'
        } ${mobile ? 'w-full text-lg h-[56px]' : 'md:text-sm lg:text-base focus-visible:ring-2 focus-visible:ring-white'}`}
      >
        <span className="flex items-center">
          {pathname === '/' && !mobile && <span className="mr-2" aria-hidden="true">🏠</span>}
          <span>Dashboard</span>
        </span>
        {mobile && <span className="text-xl" aria-hidden="true">›</span>}
      </Link>
      {hasPortfolio && (
        <Link
          href="/portfolio"
          onClick={() => setIsMobileMenuOpen(false)}
          aria-current={pathname === '/portfolio' ? 'page' : undefined}
          className={`md:px-2 lg:px-4 px-4 py-3 md:py-2 rounded-lg font-medium transition duration-200 flex items-center justify-between border-2 ${
            pathname === '/portfolio'
              ? mobile
                ? 'bg-green-800 text-white border-white/40'
                : 'bg-white text-green-700 shadow-lg border-white'
              : 'text-white border-transparent hover:bg-green-800 hover:border-white/20'
          } ${mobile ? 'w-full text-lg h-[56px]' : 'md:text-sm lg:text-base focus-visible:ring-2 focus-visible:ring-white'}`}
        >
          <span className="flex items-center">
            {pathname === '/portfolio' && !mobile && <span className="mr-2" aria-hidden="true">📈</span>}
            <span>My Portfolio</span>
          </span>
          {mobile && <span className="text-xl" aria-hidden="true">›</span>}
        </Link>
      )}
      <Link
        href="/search"
        onClick={() => setIsMobileMenuOpen(false)}
        aria-current={pathname === '/search' ? 'page' : undefined}
        className={`md:px-2 lg:px-4 px-4 py-3 md:py-2 rounded-lg font-medium transition duration-200 flex items-center justify-between border-2 ${
          pathname === '/search'
            ? mobile
              ? 'bg-green-800 text-white border-white/40'
              : 'bg-white text-green-700 shadow-lg border-white'
            : 'text-white border-transparent hover:bg-green-800 hover:border-white/20'
        } ${mobile ? 'w-full text-lg h-[56px]' : 'md:text-sm lg:text-base focus-visible:ring-2 focus-visible:ring-white'}`}
      >
        <span className="flex items-center">
          {pathname === '/search' && !mobile && <span className="mr-2" aria-hidden="true">🔍</span>}
          <span>Deepmoney Search</span>
        </span>
        {mobile && <span className="text-xl" aria-hidden="true">›</span>}
      </Link>
      {(session?.user as any)?.role === 'admin' && (
        <Link
          href="/admin/users"
          onClick={() => setIsMobileMenuOpen(false)}
          aria-current={pathname === '/admin/users' ? 'page' : undefined}
          className={`md:px-2 lg:px-4 px-4 py-3 md:py-2 rounded-lg font-medium transition duration-200 flex items-center justify-between border-2 ${
            pathname === '/admin/users'
              ? mobile
                ? 'bg-green-800 text-white border-white/40'
                : 'bg-white text-green-700 shadow-lg border-white'
              : 'text-white border-transparent hover:bg-green-800 hover:border-white/20'
          } ${mobile ? 'w-full text-lg h-[56px]' : 'md:text-sm lg:text-base focus-visible:ring-2 focus-visible:ring-white'}`}
        >
          <span className="flex items-center">
            {pathname === '/admin/users' && !mobile && <span className="mr-2" aria-hidden="true">🛡️</span>}
            <span>Admin Users</span>
          </span>
          {mobile && <span className="text-xl" aria-hidden="true">›</span>}
        </Link>
      )}
      {/* Profile link — mobile only. On desktop, Profile lives in the avatar dropdown. */}
      {mobile && session?.user && (
        <Link
          href="/profile"
          onClick={() => setIsMobileMenuOpen(false)}
          aria-current={pathname === '/profile' ? 'page' : undefined}
          className={`px-4 py-3 rounded-lg font-medium transition duration-200 flex items-center justify-between border-2 w-full text-lg h-[56px] ${
            pathname === '/profile'
              ? 'bg-green-800 text-white border-white/40'
              : 'text-white border-transparent hover:bg-green-800 hover:border-white/20'
          }`}
        >
          <span>My Profile</span>
          <span className="text-xl" aria-hidden="true">›</span>
        </Link>
      )}
    </>
  );

  return (
    <header>
      <nav className="bg-[var(--brand-green-700)] shadow-lg sticky top-0 z-40 w-full" aria-label="Main navigation">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <Link href="/" className="flex items-center gap-2 md:gap-1 lg:gap-2 md:text-lg lg:text-2xl text-2xl font-bold text-white focus-visible:ring-2 focus-visible:ring-white rounded-md p-1">
                <Image
                  src="/growmystock_logo.svg"
                  alt="Grow My Stocks"
                  width={35}
                  height={35}
                  priority
                />
                <span aria-hidden="true">
                  <span className="font-medium">Grow</span>
                  <span className="text-[#dcfce7] font-semibold text-[1.1em] mr-px ml-[3px]">
                    MY
                  </span>
                  <span className="font-medium">Stocks</span>
                </span>
              </Link>
            </div>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center md:space-x-1 lg:space-x-4">
              <NavLinks />
              {session?.user?.name && (
                <div className="relative" ref={profileRef}>
                  <button
                    onClick={() => setIsProfileOpen(!isProfileOpen)}
                    className="flex items-center justify-center md:h-9 md:w-9 lg:h-11 lg:w-11 rounded-full cursor-pointer focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-600 bg-[#cfffdf] text-[#09522b]"
                    aria-expanded={isProfileOpen}
                    aria-haspopup="true"
                    aria-label={`User menu for ${session.user.name}`}
                  >
                    {initials}
                  </button>

                  {isProfileOpen && (
                    <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg py-1 z-50 ring-1 ring-black ring-opacity-5 focus:outline-none" role="menu">
                      <div className="px-4 py-2 text-sm text-gray-700 border-b border-gray-200 text-[16px] font-semibold" role="none"> 
                        {session.user.name}
                      </div>
                      <Link
                        href="/profile"
                        className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer focus:bg-gray-100 focus:outline-none"
                        role="menuitem"
                        onClick={() => setIsProfileOpen(false)}
                      >
                        Profile
                      </Link>
                      {(session.user as any).role === 'admin' && (
                        <Link
                          href="/admin/users"
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer focus:bg-gray-100 focus:outline-none"
                          role="menuitem"
                          onClick={() => setIsProfileOpen(false)}
                        >
                          Admin Panel
                        </Link>
                      )}
                      <button
                        onClick={() => signOut({ callbackUrl: `${process.env.NEXT_PUBLIC_NEXTAUTH_URL || ''}/login` })}
                        className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 cursor-pointer focus:bg-gray-100 focus:outline-none"
                        role="menuitem"
                      >
                        Log Out
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Mobile Hamburger Button */}
            <div className="flex md:hidden items-center">
              <button
                ref={mobileTriggerRef}
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                className="inline-flex items-center justify-center p-2 rounded-md text-white hover:bg-green-800 focus:outline-none w-[44px] h-[44px] focus-visible:ring-2 focus-visible:ring-white"
                aria-expanded={isMobileMenuOpen}
                aria-controls="mobile-menu"
                aria-label={isMobileMenuOpen ? "Close main menu" : "Open main menu"}
              >
                {isMobileMenuOpen ? (
                  <svg className="block h-8 w-8 transition-transform duration-150 ease-in-out" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="block h-8 w-8 transition-transform duration-150 ease-in-out" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
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
        id="mobile-menu"
        ref={mobileMenuRef}
        className={`fixed inset-0 z-50 md:hidden transition-opacity duration-300 ${isMobileMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        role="dialog"
        aria-modal="true"
        aria-label="Main menu"
      >
        {/* Scrim Overlay */}
        <div 
          className="absolute inset-0 bg-white bg-opacity-50 opacity-70"
          onClick={() => setIsMobileMenuOpen(false)}
          aria-hidden="true"
        />
        
        {/* Drawer Content */}
        <div
          className={`absolute top-0 right-0 h-full w-[80%] max-w-[320px] shadow-xl transition-transform duration-200 ease-out transform bg-[var(--brand-green-700)] ${isMobileMenuOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
          <div className="flex flex-col h-full pt-5 pb-6">
            <div className="px-5 mb-8 flex justify-between items-center">
              <span className="text-xl text-white"><span className="font-medium">Grow</span><span className="text-[#baeb9e] font-semibold"> My </span><span className="font-medium">Stocks</span></span>
              <button 
                onClick={() => setIsMobileMenuOpen(false)}
                className="text-white p-2 w-[44px] h-[44px] flex items-center justify-center hover:bg-green-800 rounded-md focus-visible:ring-2 focus-visible:ring-white"
                aria-label="Close menu"
              >
                <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {session?.user && (
              <div className="px-5 mb-6 flex items-center space-x-3">
                <div
                  className="h-12 w-12 rounded-full flex items-center justify-center font-bold border-2 border-white/20 bg-[#cfffdf] text-[#09522b]"
                >
                  {initials}
                </div>
                <div className="text-white">
                  <p className="text-sm font-medium text-white/90">Hi,</p>
                  <p className="text-lg font-bold leading-tight text-white">{session.user.name}</p>
                </div>
              </div>
            )}

            <div className="flex-1 px-2 space-y-1">
              <NavLinks mobile={true} />
            </div>

            <div className="px-5 mt-auto pt-6 border-t border-white/20">
              <button
                onClick={() => signOut({ callbackUrl: `${process.env.NEXT_PUBLIC_NEXTAUTH_URL || ''}/login` })}
                className="flex items-center space-x-2 text-white hover:bg-green-800 py-3 w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-md px-2"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1h3v-3H7" />
                </svg>
                <span>Log Out</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
