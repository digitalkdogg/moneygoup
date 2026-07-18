'use client';

/**
 * AiTakePanel — the "Ask AI" button + result card on /search/[ticker].
 *
 * Renders a green button. On click, hits /api/prediction/[ticker]/ai-take
 * and displays the returned paragraph in a card. Handles the three failure
 * modes cleanly: 503 (Ollama unavailable) hides the button entirely for the
 * rest of the session; 429 (rate limited) shows a soft warning; anything
 * else is a generic error message with a retry affordance.
 */
import React, { useCallback, useState } from 'react';

interface AiTakeResponse {
  paragraph:     string;
  cached:        boolean;
  generatedAt:   string;
  model:         string;
  asOfGps:       number | string | null;
  /** Present when the user tried to regenerate but was throttled — the
   *  server returned the cached copy instead of a 429. UI shows a small
   *  neutral note under the paragraph. */
  rateLimited?:  boolean;
  rateLimitNote?: string;
}

interface AiTakePanelProps {
  ticker: string;
}

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; take: AiTakeResponse }
  | { kind: 'error'; message: string };

const AiTakePanel: React.FC<AiTakePanelProps> = ({ ticker }) => {
  const [state,  setState]  = useState<PanelState>({ kind: 'idle' });
  const [hidden, setHidden] = useState(false);   // true only if the service reported 503

  const fetchTake = useCallback(async (fresh: boolean) => {
    setState({ kind: 'loading' });
    try {
      const url = `/api/prediction/${encodeURIComponent(ticker)}/ai-take${fresh ? '?fresh=1' : ''}`;
      const res = await fetch(url);
      if (res.status === 503) {
        setHidden(true);
        return;
      }
      // Note: 429 is now only returned when we're throttled AND there's no
      // cached copy to fall back to. The common case (throttled but cache
      // exists) comes back as 200 with rateLimited: true — handled below
      // in the 'ready' branch by rendering rateLimitNote.
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        setState({ kind: 'error', message: body?.message ?? 'Rate limited. Please try again later.' });
        return;
      }
      if (res.status === 404) {
        setState({ kind: 'error', message: 'No analysis data available for this ticker yet.' });
        return;
      }
      if (!res.ok) {
        setState({ kind: 'error', message: 'The AI service returned an error. Please try again.' });
        return;
      }
      const body = (await res.json()) as AiTakeResponse;
      setState({ kind: 'ready', take: body });
    } catch {
      setState({ kind: 'error', message: 'Could not reach the AI service.' });
    }
  }, [ticker]);

  if (hidden) return null;

  const formatGeneratedAt = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  };

  return (
    <div className="mt-6 bg-blue-50 border border-blue-200 p-6 rounded-lg section-ai-take">
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

        {state.kind === 'ready' && (
          <button
            onClick={() => fetchTake(true)}
            className="px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 text-green-700 text-xs font-semibold transition-colors focus-ring"
            title="Regenerate the take from the latest data"
          >
            ↻ Regenerate
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

      {state.kind === 'ready' && (
        <>
          <p className="text-gray-800 leading-relaxed whitespace-pre-line">
            {state.take.paragraph}
          </p>
          <div className="mt-3 text-[11px] text-gray-500 font-medium">
            Generated {formatGeneratedAt(state.take.generatedAt)}
          </div>
          {state.take.rateLimited && state.take.rateLimitNote && (
            <div className="mt-2 text-[11px] text-gray-500 italic">
              {state.take.rateLimitNote}
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
