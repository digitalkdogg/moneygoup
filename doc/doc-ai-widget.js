/**
 * doc-ai-widget.js — Ask AI widget for GrowMYStocks developer docs.
 * Include this script at the bottom of any /doc HTML page:
 *   <script src="doc-ai-widget.js"></script>
 */
(function () {
  'use strict';

  var API_URL = 'http://localhost:7863/ask';

  // ── Styles ────────────────────────────────────────────────────────────────
  var css = `
    #doc-ai-fab {
      position: fixed; bottom: 28px; right: 28px; z-index: 9999;
      background: #1a6b3c; color: #fff; border: none; border-radius: 50px;
      padding: 12px 20px; font-size: 14px; font-weight: 600;
      cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      display: flex; align-items: center; gap: 8px; transition: background .2s;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #doc-ai-fab:hover { background: #155c33; }
    #doc-ai-panel {
      position: fixed; bottom: 90px; right: 28px; z-index: 9998;
      width: 560px; max-width: calc(100vw - 40px);
      background: #fff; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      display: none; flex-direction: column; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #doc-ai-panel.open { display: flex; }
    #doc-ai-header {
      background: #1a6b3c; color: #fff;
      padding: 14px 16px; font-weight: 700; font-size: 14px;
      display: flex; justify-content: space-between; align-items: center;
    }
    #doc-ai-close {
      background: none; border: none; color: #fff;
      font-size: 20px; cursor: pointer; line-height: 1; padding: 0;
    }
    #doc-ai-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    #doc-ai-input {
      width: 100%; box-sizing: border-box;
      border: 1.5px solid #d1d5db; border-radius: 8px;
      padding: 10px 12px; font-size: 13px; resize: vertical;
      font-family: inherit; min-height: 90px; outline: none;
      transition: border-color .2s;
    }
    #doc-ai-input:focus { border-color: #1a6b3c; }
    #doc-ai-submit {
      background: #1a6b3c; color: #fff; border: none;
      border-radius: 8px; padding: 10px 16px; font-size: 13px;
      font-weight: 600; cursor: pointer; align-self: flex-end;
      font-family: inherit; transition: background .2s;
    }
    #doc-ai-submit:hover:not(:disabled) { background: #155c33; }
    #doc-ai-submit:disabled { background: #6b7280; cursor: default; }
    #doc-ai-answer {
      background: #f9fafb; border-radius: 8px; padding: 12px;
      font-size: 13px; line-height: 1.6; color: #111827;
      max-height: 420px; overflow-y: auto; display: none;
      white-space: pre-wrap; word-break: break-word;
    }
    #doc-ai-sources {
      font-size: 12px; color: #6b7280; display: none; margin-top: 4px;
    }
    #doc-ai-sources strong { display: block; margin-bottom: 4px; color: #374151; }
    #doc-ai-sources a {
      display: inline-flex; align-items: center; gap: 5px;
      margin: 2px 4px 2px 0; padding: 3px 10px;
      background: #f0fdf4; border: 1px solid #bbf7d0;
      border-radius: 20px; color: #166534; text-decoration: none;
      font-size: 12px; font-weight: 500; transition: background .15s;
    }
    #doc-ai-sources a:hover { background: #dcfce7; }
    .doc-ai-spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid #d1d5db; border-top-color: #1a6b3c;
      border-radius: 50%; animation: doc-ai-spin .7s linear infinite;
      vertical-align: middle; margin-right: 6px;
    }
    @keyframes doc-ai-spin { to { transform: rotate(360deg); } }
  `;

  // ── DOM ───────────────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var fab = document.createElement('button');
  fab.id = 'doc-ai-fab';
  fab.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg> Ask AI';
  document.body.appendChild(fab);

  var panel = document.createElement('div');
  panel.id = 'doc-ai-panel';
  panel.innerHTML = `
    <div id="doc-ai-header">
      <span>Ask AI about these docs</span>
      <button id="doc-ai-close" title="Close">&times;</button>
    </div>
    <div id="doc-ai-body">
      <textarea id="doc-ai-input" placeholder="Ask anything about the GrowMYStocks codebase, API, schema…"></textarea>
      <button id="doc-ai-submit">Ask</button>
      <div id="doc-ai-answer"></div>
      <div id="doc-ai-sources"></div>
    </div>
  `;
  document.body.appendChild(panel);

  // ── Elements ──────────────────────────────────────────────────────────────
  var input   = document.getElementById('doc-ai-input');
  var submit  = document.getElementById('doc-ai-submit');
  var answer  = document.getElementById('doc-ai-answer');
  var sources = document.getElementById('doc-ai-sources');

  // ── Behaviour ─────────────────────────────────────────────────────────────
  fab.addEventListener('click', function () {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) input.focus();
  });

  document.getElementById('doc-ai-close').addEventListener('click', function () {
    panel.classList.remove('open');
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit.click();
  });

  submit.addEventListener('click', function () {
    var q = input.value.trim();
    if (!q) return;

    submit.disabled = true;
    submit.innerHTML = '<span class="doc-ai-spinner"></span>Thinking…';
    answer.style.display  = 'block';
    answer.textContent    = '';
    sources.style.display = 'none';
    sources.innerHTML     = '';

    fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question: q }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          answer.textContent = 'Error: ' + data.error;
        } else {
          answer.textContent = data.answer || '(no answer)';
          if (data.sources && data.sources.length) {
            sources.style.display = 'block';
            sources.innerHTML = '<strong>Sources</strong>' +
              data.sources.map(function (s) {
                return '<a href="' + s + '" target="_blank">📄 ' + s.replace('.html', '') + '</a>';
              }).join('');
          }
        }
      })
      .catch(function (err) {
        answer.textContent = 'Could not reach the Doc AI server (localhost:7863). Is it running?\n\n' + err;
      })
      .finally(function () {
        submit.disabled = false;
        submit.textContent = 'Ask';
      });
  });
})();
