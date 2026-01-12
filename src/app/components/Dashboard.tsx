'use client'

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="bg-white rounded-2xl shadow-2xl p-12 text-center">
          <h2 className="text-4xl font-bold text-gray-800 mb-6">Dashboard</h2>
          <div className="inline-block bg-blue-100 rounded-lg p-8">
            <p className="text-xl text-blue-600 font-semibold mb-4">Coming Soon</p>
            <p className="text-gray-600 text-lg max-w-md">
              The dashboard feature is under development. Soon you'll be able to add your favorite stocks for quick access and track them all in one place.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
