import { NextResponse } from "next/server";
import { isPreviewModeEnabled } from "./preview";

const ALLOWED_PREVIEW_APIS = [
  '/api/preview/contact',
  '/api/auth',
];

export function checkPreviewModeAPI(pathname: string): NextResponse | null {
  if (!isPreviewModeEnabled()) {
    return null;
  }

  const isAllowedApi = ALLOWED_PREVIEW_APIS.some(allowed =>
    pathname.startsWith(allowed)
  );

  if (!isAllowedApi) {
    return NextResponse.json(
      { error: 'Preview mode active' },
      { status: 503 }
    );
  }

  return null;
}
