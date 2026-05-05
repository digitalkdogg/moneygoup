import { NextResponse } from 'next/server';

export async function GET() {
  const previewEnv = process.env.PREVIEW;
  const isEnabled = previewEnv?.toLowerCase() === 'true';

  return NextResponse.json({
    previewEnv,
    isEnabled,
    timestamp: new Date().toISOString(),
  });
}
