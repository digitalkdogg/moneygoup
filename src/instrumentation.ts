/**
 * Next.js instrumentation hook — runs ONCE per server process at startup.
 *
 * Used to preload the Gemma model for the /api/prediction/[ticker]/ai-take
 * route. Without this, the first user click of the day pays a ~30-40s
 * model-load penalty; with it, the model is pinned in Ollama's memory
 * (via keep_alive) before any user hits the route.
 *
 * Fire-and-forget: warmup failures never crash the server. If Ollama isn't
 * reachable at boot, we log a warning and move on — the /ai-take route has
 * its own reachability guard that returns 503 gracefully.
 */

export async function register() {
  // instrumentation.ts fires in both node and edge runtimes; only the node
  // runtime can talk to a localhost Ollama, so bail out on edge.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Respect the same kill switch the /ai-take route uses.
  if (process.env.AI_TAKE_ENABLED === 'off') return;

  const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model           = process.env.OLLAMA_MODEL_AI_TAKE || 'gemma3:4b';

  // Detached — do not await. Boot must not block on Ollama.
  void (async () => {
    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), 60_000);

      const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          model,
          prompt:      'ok',   // shortest possible prompt
          stream:      false,
          keep_alive:  '24h',  // pin the model in memory after warmup
          options:     { num_predict: 1, temperature: 0 },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        // Structured line so it stands out in the boot log next to Next.js output.
        console.log(`[ai-take warmup] ${model} preloaded on ${OLLAMA_BASE_URL}`);
      } else {
        console.warn(`[ai-take warmup] non-2xx from Ollama (${res.status}) — first user click may be slow`);
      }
    } catch (err) {
      console.warn(
        `[ai-take warmup] failed to preload ${model} — first user click may be slow`,
        err instanceof Error ? err.message : String(err),
      );
    }
  })();
}
