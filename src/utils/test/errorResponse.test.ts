import { NextResponse } from 'next/server';
import {
  createErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  validationErrorResponse,
  forbiddenResponse
} from '../errorResponse';

// Mock logger to avoid actual logging during tests
jest.mock('../logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Mock randomUUID to have a predictable correlationId
jest.mock('crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
}));

describe('errorResponse', () => {
  describe('createErrorResponse', () => {
    test('returns a 500 status by default', () => {
      const response = createErrorResponse(new Error('Test error'), 'Generic error message');
      expect(response.status).toBe(500);
    });

    test('returns the provided message and correlationId', async () => {
      const response = createErrorResponse(new Error('Test error'), 'Human readable message');
      const data = await response.json();
      expect(data).toEqual({
        message: 'Human readable message',
        correlationId: 'test-uuid-1234',
      });
    });

    test('respects custom status code', () => {
      const response = createErrorResponse(new Error('Test error'), 'Message', { status: 503 });
      expect(response.status).toBe(503);
    });
  });

  describe('convenience wrappers', () => {
    test('unauthorizedResponse returns 401', async () => {
      const response = unauthorizedResponse('No access');
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.message).toBe('No access');
    });

    test('notFoundResponse returns 404', async () => {
      const response = notFoundResponse('Item not found');
      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.message).toBe('Item not found');
    });

    test('validationErrorResponse returns 400', async () => {
      const response = validationErrorResponse('Invalid input');
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.message).toBe('Invalid input');
    });

    test('forbiddenResponse returns 403', async () => {
      const response = forbiddenResponse('Forbidden access');
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.message).toBe('Forbidden access');
    });
  });
});
