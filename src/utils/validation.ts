import { NextRequest, NextResponse } from 'next/server';
import { ZodSchema, z } from 'zod';

type Middleware<T> = (
  req: NextRequest,
  res: NextResponse,
  next: (data: T) => Promise<NextResponse> | NextResponse
) => Promise<NextResponse> | NextResponse;

export const validate =
  <T extends ZodSchema>(schema: T): Middleware<z.infer<T>> =>
  async (req, res, next) => {
    try {
      const body = await req.json();
      const validatedData = schema.parse(body);
      return next(validatedData);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          {
            message: 'Validation Error',
            errors: error.errors.map((err) => ({
              path: err.path.join('.'),
              message: err.message,
            })),
          },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { message: 'Internal Server Error', error: error.message },
        { status: 500 }
      );
    }
  };

