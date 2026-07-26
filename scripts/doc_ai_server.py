#!/usr/bin/env python3
"""
doc_ai_server.py — Standalone RAG-lite AI server for /doc HTML files.

Indexes every .html file in the /doc directory at startup, exposes a single
POST /ask endpoint. On each query it scores chunks with BM25-lite, feeds the
top chunks + question into Ollama (llama3.2), and streams the answer back.

Usage:
    python3 scripts/doc_ai_server.py              # default port 7863
    python3 scripts/doc_ai_server.py --port 7864
    python3 scripts/doc_ai_server.py --model gemma3:4b

Endpoints:
    POST /ask   body: {"question":"..."} → {"answer":"...", "sources":[...]}
    GET  /health → {"status":"ok","docs":N,"chunks":M}
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import threading
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import NamedTuple

import requests

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
DOC_DIR      = PROJECT_ROOT / 'doc'

OLLAMA_BASE  = os.getenv('OLLAMA_BASE_URL', 'http://localhost:11434')
OLLAMA_MODEL = os.getenv('OLLAMA_MODEL', 'llama3.2')

CHUNK_WORDS    = 600   # target words per chunk
CHUNK_OVERLAP  = 80    # overlap between consecutive chunks
TOP_K_FILES    = 3     # top-scoring files whose chunks are sent to Ollama
TOP_K_CHUNKS   = 8     # max chunks drawn from the top files
MAX_CTX_CHARS  = 10000 # hard cap on combined context sent to model

# ── HTML → plain text ─────────────────────────────────────────────────────────
_TAG_RE   = re.compile(r'<[^>]+>')
_WS_RE    = re.compile(r'\s+')
_ENT_MAP  = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' '}

def strip_html(html: str) -> str:
    text = _TAG_RE.sub(' ', html)
    for ent, ch in _ENT_MAP.items():
        text = text.replace(ent, ch)
    return _WS_RE.sub(' ', text).strip()

def extract_sections(html: str, filename: str) -> list[dict]:
    """Split HTML into sections by heading tags, return list of {title, text, file}."""
    heading_re = re.compile(r'<h[1-3][^>]*>(.*?)</h[1-3]>', re.IGNORECASE | re.DOTALL)
    sections   = []
    last_end   = 0
    current_title = filename

    for m in heading_re.finditer(html):
        chunk_html = html[last_end:m.start()]
        chunk_text = strip_html(chunk_html).strip()
        if chunk_text:
            sections.append({'title': current_title, 'text': chunk_text, 'file': filename})
        current_title = strip_html(m.group(1)).strip() or filename
        last_end = m.end()

    tail = strip_html(html[last_end:]).strip()
    if tail:
        sections.append({'title': current_title, 'text': tail, 'file': filename})

    return sections or [{'title': filename, 'text': strip_html(html), 'file': filename}]

def chunk_section(section: dict, chunk_words: int = CHUNK_WORDS, overlap: int = CHUNK_OVERLAP) -> list[dict]:
    """Break a section's text into fixed-size word-windows with overlap."""
    words = section['text'].split()
    if len(words) <= chunk_words:
        return [section]
    chunks = []
    step = max(1, chunk_words - overlap)
    for i in range(0, len(words), step):
        window = words[i:i + chunk_words]
        chunks.append({
            'title': section['title'],
            'text':  ' '.join(window),
            'file':  section['file'],
        })
        if i + chunk_words >= len(words):
            break
    return chunks

# ── Index ─────────────────────────────────────────────────────────────────────
class Chunk(NamedTuple):
    file:  str
    title: str
    text:  str
    toks:  frozenset[str]   # unique lowercase tokens for BM25

class Index:
    def __init__(self):
        self.chunks:  list[Chunk] = []
        self.df:      dict[str, int] = defaultdict(int)   # document frequency
        self._lock    = threading.Lock()
        self.doc_names: list[str] = []

    def build(self, doc_dir: Path):
        html_files = sorted(doc_dir.glob('*.html'))
        raw_chunks: list[dict] = []
        names: list[str] = []
        for path in html_files:
            try:
                html = path.read_text(encoding='utf-8', errors='replace')
                sections = extract_sections(html, path.name)
                for sec in sections:
                    raw_chunks.extend(chunk_section(sec))
                names.append(path.name)
            except Exception as e:
                print(f'[index] skipping {path.name}: {e}', file=sys.stderr)

        chunks: list[Chunk] = []
        df: dict[str, int] = defaultdict(int)
        for rc in raw_chunks:
            # Include section title in token set so heading keywords (e.g.
            # "FEATURE_COLUMNS") contribute to BM25 scoring.
            combined = rc['title'] + ' ' + rc['text']
            toks = frozenset(re.findall(r'[a-z0-9]+', combined.lower()))
            for t in toks:
                df[t] += 1
            chunks.append(Chunk(rc['file'], rc['title'], rc['text'], toks))

        with self._lock:
            self.chunks   = chunks
            self.df       = dict(df)
            self.doc_names = names

        print(f'[index] built: {len(names)} docs, {len(chunks)} chunks', file=sys.stderr)

    def _bm25_score(self, chunk: 'Chunk', q_toks: list[str], N: int,
                    avgdl: float, k1: float = 1.5, b: float = 0.75) -> float:
        # Score against title+text so section headings ("FEATURE_COLUMNS",
        # "Step 4", etc.) contribute to relevance.
        combined = chunk.title + ' ' + chunk.text
        doc_len = len(combined.split())
        word_counts: dict[str, int] = defaultdict(int)
        for w in combined.lower().split():
            word_counts[w] += 1
        score = 0.0
        for t in q_toks:
            tf  = word_counts[t]
            idf = math.log((N - self.df.get(t, 0) + 0.5) / (self.df.get(t, 0) + 0.5) + 1)
            score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc_len / avgdl))
        return score

    def search(self, query: str, top_k_files: int = TOP_K_FILES,
               top_k_chunks: int = TOP_K_CHUNKS) -> list['Chunk']:
        """
        Two-stage retrieval:
          1. Score every chunk with BM25, aggregate per file (sum + filename bonus).
          2. Return top-scoring chunks from each selected file in SCORE order so
             the most relevant chunks arrive first before the char-limit cuts off.
        """
        q_toks = re.findall(r'[a-z0-9]+', query.lower())
        if not q_toks:
            return []

        with self._lock:
            chunks = self.chunks[:]
            df     = self.df

        N = len(chunks)
        if N == 0:
            return []

        avgdl = sum(len(c.text.split()) for c in chunks) / N

        # Score every chunk
        chunk_scores: list[float] = []
        for chunk in chunks:
            chunk_scores.append(self._bm25_score(chunk, q_toks, N, avgdl))

        # Aggregate: sum of chunk scores per file — rewards files with many
        # relevant chunks over files with one keyword-rich overview chunk.
        file_score_sum: dict[str, float] = defaultdict(float)
        file_chunk_scores: dict[str, list[tuple[float, int]]] = defaultdict(list)
        for i, (chunk, score) in enumerate(zip(chunks, chunk_scores)):
            if score > 0:
                file_score_sum[chunk.file] += score
                file_chunk_scores[chunk.file].append((score, i))

        # Filename-token bonus: if query tokens appear in the filename, boost
        # that file's score so e.g. "prediction_workflow.html" ranks first for
        # "prediction columns" queries even if overview files have more total
        # BM25 mass.
        q_tok_set = set(q_toks)
        for f in list(file_score_sum.keys()):
            stem_toks = set(re.findall(r'[a-z0-9]+', f.replace('.html', '').lower()))
            overlap = q_tok_set & stem_toks
            if overlap:
                # Bonus: 3 points per matching filename token (empirically ~1 good chunk score)
                file_score_sum[f] += len(overlap) * 3.0

        # Pick top files
        top_files = sorted(file_score_sum, key=lambda f: file_score_sum[f], reverse=True)[:top_k_files]

        # Return chunks in SCORE ORDER (highest-scoring first) so the most
        # relevant content lands within MAX_CTX_CHARS before the limit cuts off.
        # Top file gets 6 chunks; secondary files get 4 each.
        result_chunks: list[tuple[float, int]] = []
        for rank, f in enumerate(top_files):
            limit = 6 if rank == 0 else 4
            ranked = sorted(file_chunk_scores[f], reverse=True)[:limit]
            result_chunks.extend(ranked)

        # Sort overall by score so best chunks come first regardless of file
        result_chunks.sort(key=lambda x: x[0], reverse=True)
        seen: set[int] = set()
        ordered: list[int] = []
        for _, idx in result_chunks:
            if idx not in seen:
                seen.add(idx)
                ordered.append(idx)

        return [chunks[i] for i in ordered]

# ── Ollama call ───────────────────────────────────────────────────────────────
def ask_ollama(question: str, context_chunks: list[Chunk], model: str) -> str:
    ctx_parts = []
    total = 0
    for c in context_chunks:
        snippet = f'[{c.file} — {c.title}]\n{c.text}'
        if total + len(snippet) > MAX_CTX_CHARS:
            snippet = snippet[:MAX_CTX_CHARS - total]
            ctx_parts.append(snippet)
            break
        ctx_parts.append(snippet)
        total += len(snippet)

    context = '\n\n---\n\n'.join(ctx_parts)
    prompt  = (
        'You are a precise technical assistant for the GrowMYStocks developer documentation.\n'
        'Answer the question using ONLY the documentation excerpts provided below.\n'
        'Be specific and thorough — include exact names, column names, values, and lists '
        'exactly as they appear in the docs. Do not summarize or generalize when the docs '
        'contain specific details. If the answer is genuinely not in the excerpts, say so.\n\n'
        f'DOCUMENTATION EXCERPTS:\n{context}\n\n'
        f'QUESTION: {question}\n\n'
        'ANSWER (be specific, include exact names/values from the docs):'
    )

    try:
        resp = requests.post(
            f'{OLLAMA_BASE}/api/generate',
            json={'model': model, 'prompt': prompt, 'stream': False},
            timeout=120,
        )
        resp.raise_for_status()
        return resp.json().get('response', '').strip()
    except Exception as e:
        return f'[Ollama error: {e}]'

# ── HTTP handler ──────────────────────────────────────────────────────────────
def make_handler(index: Index, model: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print(f'[http] {self.address_string()} {fmt % args}', file=sys.stderr)

        def _cors(self):
            self.send_header('Access-Control-Allow-Origin',  '*')
            self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if self.path == '/health':
                body = json.dumps({
                    'status': 'ok',
                    'docs':   len(index.doc_names),
                    'chunks': len(index.chunks),
                    'model':  model,
                }).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self._cors()
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self):
            if self.path != '/ask':
                self.send_response(404)
                self.end_headers()
                return

            length  = int(self.headers.get('Content-Length', 0))
            raw     = self.rfile.read(length)
            try:
                payload  = json.loads(raw)
                question = (payload.get('question') or '').strip()
            except Exception:
                question = ''

            if not question:
                body = json.dumps({'error': 'question is required'}).encode()
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self._cors()
                self.end_headers()
                self.wfile.write(body)
                return

            chunks  = index.search(question, TOP_K_FILES, TOP_K_CHUNKS)
            sources = list(dict.fromkeys(c.file for c in chunks))
            answer  = ask_ollama(question, chunks, model)

            body = json.dumps({'answer': answer, 'sources': sources}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self._cors()
            self.end_headers()
            self.wfile.write(body)

    return Handler

# ── Entry ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Doc AI server')
    parser.add_argument('--port',  type=int,  default=int(os.getenv('DOC_AI_PORT', '7863')))
    parser.add_argument('--model', type=str,  default=OLLAMA_MODEL)
    args = parser.parse_args()

    index = Index()
    print(f'[startup] indexing {DOC_DIR} …', file=sys.stderr)
    index.build(DOC_DIR)

    server = HTTPServer(('0.0.0.0', args.port), make_handler(index, args.model))
    print(f'[startup] listening on :{args.port} (model={args.model})', file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('[shutdown] bye', file=sys.stderr)

if __name__ == '__main__':
    main()
