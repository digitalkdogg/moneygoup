import { NextRequest } from 'next/server';
import { GET, PATCH } from '@/app/api/admin/users/route';
import { getServerSession } from 'next-auth';
import { executeRawQuery, update } from '@/utils/databaseHelper';

// Mock dependencies
jest.mock('next-auth');
jest.mock('@/utils/databaseHelper');
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('Admin Users API', () => {
  let mockRequest: any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/admin/users', () => {
    test('returns 401 if no session', async () => {
      (getServerSession as jest.Mock).mockResolvedValue(null);
      mockRequest = { nextUrl: new URL('http://localhost/api/admin/users') } as unknown as NextRequest;
      const response = await GET(mockRequest);
      expect(response.status).toBe(401);
    });

    test('returns 403 if user is not an admin', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'user' } });
      mockRequest = { nextUrl: new URL('http://localhost/api/admin/users') } as unknown as NextRequest;
      const response = await GET(mockRequest);
      expect(response.status).toBe(403);
    });

    test('returns user list for admin', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'admin' } });
      const mockUsers = [{ id: 1, username: 'testuser', role: 'user', approval_status: 'pending' }];
      (executeRawQuery as jest.Mock).mockResolvedValue([mockUsers]);

      const url = 'http://localhost/api/admin/users';
      mockRequest = { 
        url,
        nextUrl: new URL(url) 
      } as unknown as NextRequest;
      const response = await GET(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.users).toEqual(mockUsers);
      expect(executeRawQuery).toHaveBeenCalledWith(expect.stringContaining('SELECT'), expect.any(Array));
    });

    test('applies filters correctly', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({ user: { role: 'admin' } });
      (executeRawQuery as jest.Mock).mockResolvedValue([[]]);

      const url = 'http://localhost/api/admin/users?status=pending&role=superuser&search=kevin';
      mockRequest = { 
        url,
        nextUrl: new URL(url) 
      } as unknown as NextRequest;
      
      await GET(mockRequest);

      expect(executeRawQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND approval_status = ? AND role = ? AND username LIKE ?'),
        ['pending', 'superuser', '%kevin%']
      );
    });
  });

  describe('PATCH /api/admin/users', () => {
    test('updates user status successfully', async () => {
      const adminSession = { user: { id: 99, role: 'admin' } };
      (getServerSession as jest.Mock).mockResolvedValue(adminSession);
      (update as jest.Mock).mockResolvedValue(1);

      mockRequest = {
        json: jest.fn().mockResolvedValue({ 
          userId: 1, 
          approval_status: 'approved' 
        })
      } as unknown as NextRequest;

      const response = await PATCH(mockRequest);
      expect(response.status).toBe(200);
      
      expect(update).toHaveBeenCalledWith(
        'users', 
        expect.objectContaining({ 
          approval_status: 'approved',
          approved_by: 99 
        }), 
        { id: 1 }
      );
    });

    test('prevents demoting the last admin', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 99, role: 'admin' } });
      
      // Mock count check
      (executeRawQuery as jest.Mock)
        .mockResolvedValueOnce([[{ count: 1 }]]) // count of admins
        .mockResolvedValueOnce([[{ role: 'admin' }]]); // target user role

      mockRequest = {
        json: jest.fn().mockResolvedValue({ 
          userId: 99, 
          role: 'superuser' 
        })
      } as unknown as NextRequest;

      const response = await PATCH(mockRequest);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.message).toBe('Cannot demote the only admin');
    });

    test('updates user role successfully', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 99, role: 'admin' } });
      (update as jest.Mock).mockResolvedValue(1);
      
      // Mock count check (more than 1 admin exists)
      (executeRawQuery as jest.Mock).mockResolvedValueOnce([[{ count: 2 }]]);

      mockRequest = {
        json: jest.fn().mockResolvedValue({ 
          userId: 1, 
          role: 'superuser' 
        })
      } as unknown as NextRequest;

      const response = await PATCH(mockRequest);
      expect(response.status).toBe(200);
      
      expect(update).toHaveBeenCalledWith(
        'users', 
        { role: 'superuser' }, 
        { id: 1 }
      );
    });
  });
});
