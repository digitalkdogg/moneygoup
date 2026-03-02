import { NextRequest, NextResponse } from 'next/server';
import { validate } from '../validation';
import { z } from 'zod';

describe('validation middleware', () => {
  const schema = z.object({
    name: z.string().min(3),
    age: z.number().positive(),
  });

  const mockHandler = jest.fn().mockResolvedValue(NextResponse.json({ success: true }));

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('calls handler with validated data if input is valid', async () => {
    const body = { name: 'John', age: 30 };
    const req = {
      json: jest.fn().mockResolvedValue(body),
    } as unknown as NextRequest;

    const wrappedHandler = validate(schema)(mockHandler);
    const res = await wrappedHandler(req);

    expect(mockHandler).toHaveBeenCalledWith(req, body, undefined);
    expect(res.status).toBe(200);
  });

  test('returns 400 if input is invalid', async () => {
    const body = { name: 'Jo', age: -5 }; // Invalid: name too short, age not positive
    const req = {
      json: jest.fn().mockResolvedValue(body),
    } as unknown as NextRequest;

    const wrappedHandler = validate(schema)(mockHandler);
    const res = await wrappedHandler(req);

    expect(mockHandler).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toBe('Validation Error');
    expect(data.errors).toHaveLength(2);
  });
});
