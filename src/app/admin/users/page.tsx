'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';

interface User {
  id: number;
  username: string;
  email: string;
  role: 'user' | 'superuser' | 'admin';
  approval_status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  last_login: string | null;
  rejected_reason: string | null;
}

export default function AdminUsersPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'pending' | 'all'>('pending');
  const [search, setSearch] = useState('');

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const statusFilter = activeTab === 'pending' ? 'pending' : '';
      const res = await fetch(`/api/admin/users?status=${statusFilter}&search=${search}`);
      if (!res.ok) {
        if (res.status === 403) throw new Error('Forbidden: Admin access required');
        throw new Error('Failed to fetch users');
      }
      const data = await res.json();
      setUsers(data.users);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeTab, search]);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
    } else if (status === 'authenticated' && (session.user as any).role !== 'admin') {
      router.push('/');
    } else if (status === 'authenticated') {
      fetchUsers();
    }
  }, [status, session, router, fetchUsers]);

  const handleUpdateStatus = async (userId: number, newStatus: 'approved' | 'rejected') => {
    let reason = null;
    if (newStatus === 'rejected') {
      reason = window.prompt('Enter rejection reason:');
      if (reason === null) return;
    }

    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, approval_status: newStatus, rejected_reason: reason }),
      });

      if (!res.ok) throw new Error('Failed to update user status');
      
      // Refresh list
      fetchUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdateRole = async (userId: number, newRole: string) => {
    if (!window.confirm(`Are you sure you want to change role to ${newRole}?`)) return;

    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role: newRole }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Failed to update user role');
      }
      
      fetchUsers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (status === 'loading' || (status === 'authenticated' && loading && users.length === 0)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center space-x-4">
            <Link href="/">
              <Image src="/growmystock_logo.svg" alt="Logo" width={40} height={40} />
            </Link>
            <h1 className="text-2xl font-bold text-gray-800">Admin: User Management</h1>
          </div>
          <Link href="/" className="text-green-700 hover:underline font-medium">
            Back to Dashboard
          </Link>
        </div>

        {error && (
          <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6 shadow-sm rounded">
            {error}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="flex border-b border-gray-200 bg-gray-50">
            <button
              onClick={() => setActiveTab('pending')}
              className={`px-6 py-4 transition-colors ${
                activeTab === 'pending'
                  ? 'bg-white border-b-2 border-green-600 text-green-700'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Pending Approvals
              {users.length > 0 && activeTab === 'pending' && (
                 <span className="ml-2 bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs">
                   {users.length}
                 </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('all')}
              className={`px-6 py-4 transition-colors ${
                activeTab === 'all'
                  ? 'bg-white border-b-2 border-green-600 text-green-700'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              All Users
            </button>
          </div>

          <div className="p-4 bg-white border-b border-gray-100 flex items-center justify-between">
            <div className="relative w-full max-w-xs">
              <input
                type="text"
                placeholder="Search users..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 text-sm"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="absolute left-3 top-2.5 text-gray-400">
                🔍
              </div>
            </div>
            <button 
              onClick={() => fetchUsers()}
              className="px-4 py-2 text-green-700 hover:bg-green-50 rounded-lg"
            >
              Refresh
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-gray-600 font-medium border-b border-gray-200">
                <tr>
                  <th className="px-6 py-4">Username</th>
                  <th className="px-6 py-4">Email</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Role</th>
                  <th className="px-6 py-4">Created At</th>
                  <th className="px-6 py-4">Last Login</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-10 text-center text-gray-500">
                      No users found.
                    </td>
                  </tr>
                ) : (
                  users.map((user) => (
                    <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 font-medium text-gray-900">{user.username}</td>
                      <td className="px-6 py-4 text-gray-500">{user.email}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                          user.approval_status === 'approved' ? 'bg-green-100 text-green-800' :
                          user.approval_status === 'pending' ? 'bg-amber-100 text-amber-800' :
                          'bg-red-100 text-red-800'
                        }`}>
                          {user.approval_status.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <select
                          value={user.role}
                          onChange={(e) => handleUpdateRole(user.id, e.target.value)}
                          className="bg-transparent border-none p-0 text-sm font-medium focus:ring-0 cursor-pointer hover:underline"
                        >
                          <option value="user">User</option>
                          <option value="superuser">Superuser</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                      <td className="px-6 py-4 text-gray-500">
                        {new Date(user.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 text-gray-500">
                        {user.last_login ? new Date(user.last_login).toLocaleString() : 'Never'}
                      </td>
                      <td className="px-6 py-4 text-right space-x-2">
                        {user.approval_status === 'pending' && (
                          <>
                            <button
                              onClick={() => handleUpdateStatus(user.id, 'approved')}
                              className="text-green-600 hover:text-green-800"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleUpdateStatus(user.id, 'rejected')}
                              className="text-red-600 hover:text-red-800"
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {user.approval_status !== 'pending' && (
                           <button
                            onClick={() => handleUpdateStatus(user.id, user.approval_status === 'approved' ? 'rejected' : 'approved')}
                            className="text-gray-600 hover:text-gray-800"
                           >
                             {user.approval_status === 'approved' ? 'Reject' : 'Approve'}
                           </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
