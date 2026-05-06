import { NextResponse } from 'next/server';

export async function GET() {
  const previewEnv = process.env.PREVIEW;
  const isEnabled = previewEnv?.toLowerCase() === 'true';

  // Debug: check all env vars that might be related
  const allEnv = Object.keys(process.env)
    .filter(key => key.toLowerCase().includes('preview'))
    .reduce((acc, key) => {
      acc[key] = process.env[key];
      return acc;
    }, {} as Record<string, string | undefined>);

  return NextResponse.json({
    previewEnv,
    previewEnvType: typeof previewEnv,
    previewEnvLength: previewEnv?.length,
    previewEnvCharCodes: previewEnv ? Array.from(previewEnv).map(c => c.charCodeAt(0)) : null,
    isEnabled,
    allPreviewRelatedEnvVars: allEnv,
    timestamp: new Date().toISOString(),
  });
}
