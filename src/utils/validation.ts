import { NextRequest, NextResponse } from 'next/server'
import { ZodSchema, z } from 'zod'
import { createErrorResponse } from './errorResponse'

type Handler<T> = (
  req: NextRequest,
  data: T,
  ctx?: { params?: any }
) => Promise<NextResponse> | NextResponse

export const validate =
  <T extends ZodSchema>(schema: T) =>
  (handler: Handler<z.infer<T>>) =>
  async (req: NextRequest, ctx?: { params?: any }) => {
    try {
      const body = await req.json()
      const validatedData = schema.parse(body)
      return handler(req, validatedData, ctx)
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          {
            message: 'Validation Error',
            errors: error.issues.map((err) => ({
              path: err.path.join('.'),
              message: err.message,
            })),
          },
          { status: 400 }
        )
      }

      return createErrorResponse(error, 'Internal Server Error', { status: 500 })
    }
  }

