'use client';

/**
 * AiTakePanel — the "Ask AI" button + result card on /search/[ticker].
 *
 * Renders a green button. On click, hits /api/prediction/[ticker]/ai-take
 * and displays the returned paragraph in a card. The route streams the
 * paragraph token-by-token via chunked text/plain — this component consumes
 * that stream with a ReadableStreamDefaultReader and progressively renders
 * the partial text so users see the first sentence within 5-10s instead of
 * staring at a spinner for 60-90s while the model works.
 *
 * Metadata (cached flag, model name, generated timestamp, rate-limit note)
 * lives on custom X-AiTake-* response headers, since the body itself is
 * plain text.
 *
 * Failure modes:
 *   • 503 → Ollama unavailable OR AI_TAKE_ENABLED=off; hide the panel for
 *     the rest of the session.
 *   • 429 → user throttled AND no cached copy to fall back to (rare — the
 *     usual throttle path returns 200 with X-AiTake-Rate-Limited: true).
 *   • 404 → no GPS data for this ticker yet; show a friendly message.
 *   • Anything else → generic error with a Retry button.
 */
import React, { useCallback, useEffect, useState } from 'react';

interface AiTakeMeta {
  cached:        boolean;
  generatedAt:   string;
  model:         string;
  asOfGps:       string | null;
  rateLimited:   boolean;
  rateLimitNote?: string;
}

interface AiTakePanelProps {
  ticker: string;
}

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'streaming'; partial: string; meta: AiTakeMeta }
  | { kind: 'ready';     paragraph: string; meta: AiTakeMeta }
  | { kind: 'error';     message: string };

function readMetadataFromHeaders(res: Response): AiTakeMeta {
  return {
    cached:        res.headers.get('X-AiTake-Cached') === 'true',
    generatedAt:   res.headers.get('X-AiTake-Generated-At') ?? new Date().toISOString(),
    model:         res.headers.get('X-AiTake-Model') ?? '',
    asOfGps:       res.headers.get('X-AiTake-Asof-Gps') || null,
    rateLimited:   res.headers.get('X-AiTake-Rate-Limited') === 'true',
    rateLimitNote: res.headers.get('X-AiTake-Rate-Limit-Note') ?? undefined,
  };
}

const AiTakePanel: React.FC<AiTakePanelProps> = ({ ticker }) => {
  const [state,  setState]  = useState<PanelState>({ kind: 'idle' });
  const [hidden, setHidden] = useState(false);   // true only if the service reported 503

  // On mount, silently check for a cached take. Returns in ~100ms if the DB
  // has a hit; 204 if not — in which case we stay idle and show the button.
  useEffect(() => {
    let cancelled = false;
    const ctrl    = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/prediction/${encodeURIComponent(ticker)}/ai-take?cache_only=1`,
          { signal: ctrl.signal },
        );
        if (cancelled) return;
        if (res.status === 503) { setHidden(true); return; }
        if (!res.ok) return; // 204 = no cache, 401/403 = not authed — stay idle
        const text = await res.text();
        if (cancelled || !text.trim()) return;
        setState({ kind: 'ready', paragraph: text.trim(), meta: readMetadataFromHeaders(res) });
      } catch { /* aborted or network error — stay idle */ }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [ticker]);

  const fetchTake = useCallback(async (fresh: boolean) => {
    setState({ kind: 'loading' });
    try {
      const url = `/api/prediction/${encodeURIComponent(ticker)}/ai-take${fresh ? '?fresh=1' : ''}`;
      const res = await fetch(url);

      if (res.status === 503) {
        setHidden(true);
        return;
      }
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        setState({ kind: 'error', message: body?.message ?? 'Rate limited. Please try again later.' });
        return;
      }
      if (res.status === 404) {
        setState({ kind: 'error', message: 'No analysis data available for this ticker yet.' });
        return;
      }
      if (!res.ok || !res.body) {
        setState({ kind: 'error', message: 'The AI service returned an error. Please try again.' });
        return;
      }

      const meta    = readMetadataFromHeaders(res);
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   partial = '';

      // Progressive rendering: each chunk from Ollama gets decoded, appended,
      // and pushed into state so React re-renders with the paragraph growing.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          partial += decoder.decode(value, { stream: true });
          setState({ kind: 'streaming', partial, meta });
        }
      }
      // Flush any trailing bytes held by the incremental decoder.
      partial += decoder.decode();

      const trimmed = partial.trim();
      if (trimmed.length === 0) {
        setState({ kind: 'error', message: 'The AI service returned an empty response.' });
        return;
      }

      setState({ kind: 'ready', paragraph: trimmed, meta });
    } catch {
      setState({ kind: 'error', message: 'Could not reach the AI service.' });
    }
  }, [ticker]);

  if (hidden) return null;

  const isStreaming = state.kind === 'streaming';
  const isReady     = state.kind === 'ready';
  const hasBody     = isStreaming || isReady;
  const bodyText    = isStreaming ? state.partial : (isReady ? state.paragraph : '');
  const meta        = hasBody ? state.meta : null;

  return (
    <div className="mt-6 bg-[#f0fdf4] border border-[#86efac] p-6 rounded-lg section-ai-take">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xl" role="img" aria-label="ai-take">🤖</span>
          <h2 className="text-lg font-bold text-gray-800">AI Take</h2>
        </div>

        {state.kind === 'idle' && (
          <button
            onClick={() => fetchTake(false)}
            className="px-4 py-2 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold shadow-sm transition-colors focus-ring"
          >
            Ask AI
          </button>
        )}

        {isReady && (
          <button
            onClick={() => fetchTake(true)}
            className="sm rounded-lg bg-[#017e3b] hover:bg-[#016a32] text-white transition-colors focus-ring"
            style={{ padding: '0.375rem', fontSize: '1rem', lineHeight: 1, width: '2rem', height: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Regenerate the take from the latest data"
          >
            ↻
          </button>
        )}
      </div>

      {state.kind === 'idle' && (
        <p className="text-sm text-gray-500">
          Ask the AI to write a short paragraph on {ticker.toUpperCase()} based on the current data.
        </p>
      )}

      {state.kind === 'loading' && (
        <div className="flex items-center gap-3 py-4 text-gray-600">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-green-600" />
          <span className="text-sm font-medium">Analyzing…</span>
        </div>
      )}

      {hasBody && (
        <>
          <p className="text-gray-800 leading-relaxed whitespace-pre-line">
            {bodyText}
            {isStreaming && (
              <span
                className="inline-block w-2 h-4 bg-gray-500 ml-0.5 align-text-bottom animate-pulse"
                aria-label="Generating"
              />
            )}
          </p>
          {meta?.rateLimited && meta.rateLimitNote && (
            <div className="mt-2 text-[11px] text-gray-500 italic">
              {meta.rateLimitNote}
            </div>
          )}
        </>
      )}

      {state.kind === 'error' && (
        <div className="flex items-center justify-between gap-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <span>{state.message}</span>
          <button
            onClick={() => fetchTake(false)}
            className="text-red-800 font-semibold hover:underline"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
};

export default AiTakePanel;
