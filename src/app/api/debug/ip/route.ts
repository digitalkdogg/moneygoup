import { NextRequest, NextResponse } from 'next/server';

// TEMPORARY — delete this file after noting the proxy IPs
export async function GET(request: NextRequest) {
  return NextResponse.json({
    direct_ip: (request as any).ip ?? null,
    x_forwarded_for: request.headers.get('x-forwarded-for'),
    x_real_ip: request.headers.get('x-real-ip'),
    cf_connecting_ip: request.headers.get('cf-connecting-ip'),
  });
}
