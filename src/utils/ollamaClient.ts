/**
 * Shared thin wrapper around the local Ollama HTTP API. Every feature that
 * needs an LLM call — NER over article text, prediction rationales, news
 * event classification, backtest narration, etc. — routes through
 * `generate()` so we have exactly one place that owns:
 *
 *   • the feature flag (OLLAMA_ENABLED)
 *   • reachability probing (checkOllamaReachable)
 *   • timeout + AbortSignal handling
 *   • JSON-mode format enforcement + null-on-any-failure semantics
 *
 * Every consumer must accept `null` as a valid "Ollama unavailable" return
 * and degrade gracefully. This module NEVER throws — errors turn into
 * `null` returns so the primary pipelines that depend on it can't crash
 * when Ollama is down.
 */

const OLLAMA_BASE_URL   = process.env.OLLAMA_BASE_URL   || 'http://localhost:11434';
const OLLAMA_MODEL      = process.env.OLLAMA_MODEL      || 'llama3.2';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 8_000;
const REACHABLE_PROBE_TIMEOUT_MS = 2_000;

export interface GenerateOptions {
  /** Override the default model (env OLLAMA_MODEL). Per-feature overrides
   *  (e.g. OLLAMA_MODEL_RATIONALE) should be resolved by the caller and
   *  passed through this field. */
  model?: string;
  /** Override the default request timeout. */
  timeoutMs?: number;
  /** Ask Ollama for JSON-mode output (adds format:'json' to the request). */
  json?: boolean;
  /** Sampling temperature (default 0 — deterministic-ish; recommended for
   *  extraction/classification tasks that go through JSON parsing). */
  temperature?: number;
  /** Cap on tokens generated. Keep low for classification (~200) and higher
   *  for free-text summaries (~500). */
  numPredict?: number;
  /** How long Ollama should keep this model resident in memory after the
   *  call. Accepts Ollama's usual formats: '5m', '24h', '-1' (forever), '0'
   *  (unload immediately). Set to a long value for latency-sensitive
   *  features that get sparse traffic (e.g. the /ai-take route) so the
   *  first user of the day doesn't eat the ~30-40s model-load penalty. */
  keepAlive?: string;
  /** Optional stop sequences. Ollama halts generation the moment any of
   *  these strings appears. Useful for enforcing single-paragraph outputs
   *  (`['\n\n', '\n-', '\n1.']` etc.) so the model can't slip into lists. */
  stop?: string[];
}

export function isOllamaEnabled(): boolean {
  return (process.env.OLLAMA_ENABLED || 'false').toLowerCase() === 'true';
}

/**
 * Lightweight probe used as a precondition before launching batches of
 * generate() calls. Uses a shorter timeout than the full generation path so
 * "Ollama not running" degrades in ~2s instead of ~8s.
 */
export async function checkOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(REACHABLE_PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Send a prompt to Ollama's /api/generate and return the raw response
 * string (or the parsed JSON payload if `json: true` was set and the
 * response was well-formed).
 *
 * Returns `null` on ANY failure — network error, non-2xx, timeout, malformed
 * response, JSON parse failure. Callers must handle the null path; nothing
 * downstream should assume this succeeded.
 */
export async function generate(
  prompt: string,
  opts: GenerateOptions = {},
): Promise<string | null> {
  if (!prompt || prompt.trim().length === 0) return null;

  const model       = opts.model       ?? OLLAMA_MODEL;
  const timeoutMs   = opts.timeoutMs   ?? OLLAMA_TIMEOUT_MS;
  const temperature = opts.temperature ?? 0;
  const numPredict  = opts.numPredict  ?? 300;

  const options: Record<string, unknown> = { temperature, num_predict: numPredict };
  if (opts.stop && opts.stop.length > 0) options.stop = opts.stop;

  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
    options,
  };
  if (opts.json)      body.format     = 'json';
  if (opts.keepAlive) body.keep_alive = opts.keepAlive;

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const raw = data?.response;
    return typeof raw === 'string' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Streaming variant of `generate()`. Opens a POST to Ollama's /api/generate
 * with `stream: true` and returns a `ReadableStream<string>` that yields the
 * text delta from each Ollama JSON line as it arrives. The caller is
 * responsible for both consuming the stream AND deciding what to do at end
 * (persist to cache, tee to the client, etc.).
 *
 * Returns `null` if the initial fetch fails, times out, or Ollama returns a
 * non-2xx status. Any mid-stream error terminates the stream cleanly (the
 * consumer sees an end-of-stream, not an exception).
 *
 * Metadata (final `done` message with eval counts / durations) is NOT exposed
 * — this helper is only about the response text. If you need it, use the
 * non-streaming `generate()` or extend this helper.
 */
export async function generateStream(
  prompt: string,
  opts: GenerateOptions = {},
): Promise<ReadableStream<string> | null> {
  if (!prompt || prompt.trim().length === 0) return null;

  const model       = opts.model       ?? OLLAMA_MODEL;
  const timeoutMs   = opts.timeoutMs   ?? OLLAMA_TIMEOUT_MS;
  const temperature = opts.temperature ?? 0;
  const numPredict  = opts.numPredict  ?? 300;

  const options: Record<string, unknown> = { temperature, num_predict: numPredict };
  if (opts.stop && opts.stop.length > 0) options.stop = opts.stop;

  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: true,
    options,
  };
  if (opts.json)      body.format     = 'json';
  if (opts.keepAlive) body.keep_alive = opts.keepAlive;

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;

  // Parse Ollama's newline-delimited JSON stream into text deltas.
  // Ollama emits one JSON object per line: {"response":"…","done":false}.
  // We buffer partial lines across chunks and emit `response` fields as
  // they resolve.
  const decoder     = new TextDecoder();
  const lineBuffer  = { chunk: '' };  // wrapped so we can mutate in nested scope
  const upstream    = res.body.getReader();

  return new ReadableStream<string>({
    async pull(controller) {
      try {
        const { value, done } = await upstream.read();
        if (done) {
          // Flush any trailing partial line — Ollama's final line always ends
          // with \n in practice, so this is defensive.
          if (lineBuffer.chunk.trim()) {
            try {
              const obj = JSON.parse(lineBuffer.chunk) as { response?: string };
              if (obj.response) controller.enqueue(obj.response);
            } catch { /* ignore */ }
          }
          controller.close();
          return;
        }
        lineBuffer.chunk += decoder.decode(value, { stream: true });
        // Split on newlines; keep the last (possibly-incomplete) segment.
        const lines = lineBuffer.chunk.split('\n');
        lineBuffer.chunk = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line) as { response?: string; done?: boolean };
            if (obj.response) controller.enqueue(obj.response);
            // done=true just means the eval finished; we let the loop close
            // naturally on the next read() returning done.
          } catch {
            // Malformed line — skip. Common if a keep-alive keeps a partial
            // message alive across a chunk boundary and we already flushed.
          }
        }
      } catch {
        // Reader exception (mid-stream disconnect) — close cleanly so the
        // consumer sees end-of-stream rather than a throw.
        controller.close();
      }
    },
    cancel() {
      // Client aborted — release the upstream reader.
      upstream.cancel().catch(() => { /* ignore */ });
    },
  });
}

/**
 * Convenience wrapper around `generate()` that also runs JSON.parse on the
 * result and returns the parsed object (or null on any failure). Sets
 * `json: true` automatically so Ollama returns valid JSON.
 */
export async function generateJson<T = unknown>(
  prompt: string,
  opts: Omit<GenerateOptions, 'json'> = {},
): Promise<T | null> {
  const raw = await generate(prompt, { ...opts, json: true });
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
