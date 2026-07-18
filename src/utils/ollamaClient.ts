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
