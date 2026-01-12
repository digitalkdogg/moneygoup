'use client'

interface NavigationProps {
  currentPage: 'dashboard' | 'search'
  onNavigate: (page: 'dashboard' | 'search') => void
}

export default function Navigation({ currentPage, onNavigate }: NavigationProps) {
  return (
    <nav className="bg-gradient-to-r from-blue-600 to-indigo-600 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center">
            <h1 className="text-2xl font-bold text-white">Money Go Up</h1>
          </div>
          <div className="flex space-x-8">
            <button
              onClick={() => onNavigate('dashboard')}
              className={`px-4 py-2 rounded-lg font-semibold transition duration-200 ${
                currentPage === 'dashboard'
                  ? 'bg-white text-blue-600 shadow-lg'
                  : 'text-white hover:bg-blue-500'
              }`}
            >
              Dashboard
            </button>
            <button
              onClick={() => onNavigate('search')}
              className={`px-4 py-2 rounded-lg font-semibold transition duration-200 ${
                currentPage === 'search'
                  ? 'bg-white text-blue-600 shadow-lg'
                  : 'text-white hover:bg-blue-500'
              }`}
            >
              Search
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}
