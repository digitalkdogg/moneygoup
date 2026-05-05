export function isPreviewModeEnabled(): boolean {
  const previewEnv = process.env.PREVIEW;

  if (previewEnv === undefined || previewEnv === null) {
    return false;
  }

  return previewEnv.toLowerCase() === 'true';
}
