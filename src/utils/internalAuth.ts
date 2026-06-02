import { createHash, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { createLogger } from './logger';

const logger = createLogger('utils/internalAuth');
const MIN_SECRET_BYTES = 32;

function getValidatedSecret(): string | null {
  const secret = process.env.DEEPMONEY_INTERNAL_SECRET;
  if (!secret) return null;
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    logger.error('DEEPMONEY_INTERNAL_SECRET is too short — internal bypass disabled', {
      actualBytes: Buffer.byteLength(secret, 'utf8'),
      requiredBytes: MIN_SECRET_BYTES,
    });
    return null;
  }
  return secret;
}

// Hash both sides to equal length so timingSafeEqual works regardless of input length.
export function isInternalRequest(request: NextRequest): boolean {
  const secret = getValidatedSecret();
  if (!secret) return false;
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return false;
  const keyHash = createHash('sha256').update(apiKey).digest();
  const secretHash = createHash('sha256').update(secret).digest();
  return timingSafeEqual(keyHash, secretHash);
}
