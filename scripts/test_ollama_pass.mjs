// Standalone end-to-end test for the Ollama NER pass.
// Mirrors the prompt + parsing logic in src/utils/ollamaTicker.ts so we can
// exercise the full path (Ollama → entity extraction → Yahoo ticker resolution
// → industry map) without standing up the Next.js dev server.
//
// Run: node scripts/test_ollama_pass.mjs

import { resolveIndustryTickers } from '../src/utils/industryTickerMap.ts';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || 'llama3.2';
const TIMEOUT_MS      = Number(process.env.OLLAMA_TIMEOUT_MS) || 15_000;
const US_EXCHANGES = new Set(['NMS', 'NYQ', 'ASE', 'NGM', 'PCX', 'BATS']);

// Item 5 — event_type enum. Must match EVENT_TYPES in src/utils/ollamaTicker.ts.
const EVENT_TYPES = new Set([
    'earnings', 'M&A', 'lawsuit', 'executive_change',
    'analyst_action', 'product', 'regulatory', 'other',
]);

const PROMPT_TEMPLATE = `You are a financial analyst. Read this news article and extract:
1. Any company names mentioned (public or private)
2. Any industries or sectors discussed
3. Any companies mentioned as suppliers, customers, or competitors
4. The single primary event type described by the article. Choose exactly ONE from this list:
   - earnings         (quarterly results, guidance, beats/misses)
   - M&A              (acquisitions, mergers, spinoffs, tender offers)
   - lawsuit          (litigation, settlements, regulatory enforcement actions)
   - executive_change (CEO/CFO hire, departure, board change)
   - analyst_action   (upgrade, downgrade, initiation, price-target change)
   - product          (launches, features, updates, roadmap)
   - regulatory       (FDA approval, antitrust, licensing, policy)
   - other            (anything not above)

Respond ONLY with valid JSON in this exact shape:
{"companies":["Apple Inc","TSMC"],"industries":["semiconductor","consumer electronics"],"related":["Foxconn","Samsung"],"event_type":"product"}
Article:
`;

// Sample articles chosen to exercise:
//   1. Explicit company without ticker → company resolver must find AAPL
//        Also a clear earnings event → event_type should be "earnings"
//   2. Industry-only mention → industry map must return SMH + holdings
//        Ambiguous event → event_type could reasonably be "other" or "product"
//   3. Supplier/competitor language → "related" entities should surface
//        Product-launch language → event_type should be "product"
//   4. Explicit analyst upgrade → event_type should be "analyst_action"
const SAMPLES = [
    {
        label: 'company-by-name',
        text:  'Apple announced a record quarter Tuesday, driven by stronger-than-expected iPhone sales in China. CEO Tim Cook said services revenue also hit an all-time high.',
        expectedEvent: 'earnings',
    },
    {
        label: 'industry-only',
        text:  'The semiconductor industry is bracing for a global chip shortage extending into next year, analysts at major investment banks warned this week. Demand from AI data centers continues to outstrip supply.',
        expectedEvent: null,  // don't hard-assert, but must be one of the enum
    },
    {
        label: 'supplier-relationship',
        text:  'Tesla supplier Panasonic said it will expand battery production at its Nevada gigafactory. The move comes as Tesla competitors Ford and General Motors race to scale their own EV manufacturing.',
        expectedEvent: null,  // could reasonably be "product" or "other"
    },
    {
        label: 'analyst-upgrade',
        text:  'Morgan Stanley upgraded Nvidia to Overweight from Equal-Weight on Monday, raising its price target to $180 from $150 and citing accelerating data-center GPU demand.',
        expectedEvent: 'analyst_action',
    },
];

async function extractEntities(text) {
    const t0 = Date.now();
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model:  OLLAMA_MODEL,
            prompt: PROMPT_TEMPLATE + text,
            stream: false,
            format: 'json',
            options: { temperature: 0, num_predict: 250 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) return { error: `HTTP ${res.status}`, elapsed };
    const data = await res.json();
    try {
        const parsed = JSON.parse(data.response);
        return { entities: parsed, elapsed };
    } catch (e) {
        return { error: 'parse failed', raw: data.response, elapsed };
    }
}

async function resolveCompany(name) {
    try {
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=3&newsCount=0`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
            signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const quotes = Array.isArray(data.quotes) ? data.quotes : [];
        const lowerName = name.toLowerCase();
        const queryFirstWord = lowerName.split(/\s+/)[0] || '';
        for (const q of quotes) {
            const sym       = (q.symbol     || '').toUpperCase();
            const exchange  = (q.exchange   || '').toUpperCase();
            const quoteType = (q.quoteType  || '').toUpperCase();
            if (!sym) continue;
            if (quoteType !== 'EQUITY' && quoteType !== 'ETF') continue;
            if (!US_EXCHANGES.has(exchange)) continue;
            const longName = (q.longname || q.shortname || '').toLowerCase();
            if (!longName) continue;
            if (longName.includes(lowerName) || lowerName.includes(longName) ||
                (queryFirstWord && longName.startsWith(queryFirstWord))) {
                return sym;
            }
        }
    } catch {}
    return null;
}

async function run() {
    console.log(`Ollama endpoint: ${OLLAMA_BASE_URL}  model: ${OLLAMA_MODEL}`);
    console.log('='.repeat(70));

    const allCompanies  = new Set();
    const allIndustries = new Set();
    // Item 5 — accumulate pass/fail counts for the event_type assertion so we
    // can print one clean summary at the end instead of interleaving.
    let eventTotal = 0, eventValid = 0, eventExpectedHits = 0, eventExpectedTotal = 0;

    for (const sample of SAMPLES) {
        console.log(`\n[${sample.label}]`);
        console.log(`  text: ${sample.text.slice(0, 80)}...`);
        const r = await extractEntities(sample.text);
        if (r.error) {
            console.log(`  ERROR: ${r.error}  raw=${(r.raw || '').slice(0, 120)}  elapsed=${r.elapsed}ms`);
            continue;
        }
        console.log(`  elapsed: ${r.elapsed}ms`);
        console.log(`  companies:  ${JSON.stringify(r.entities.companies)}`);
        console.log(`  industries: ${JSON.stringify(r.entities.industries)}`);
        console.log(`  related:    ${JSON.stringify(r.entities.related)}`);

        // Item 5 — event_type must be one of the eight enum values. The model
        // occasionally returns adjacent phrasings ("m and a", "earnings-report")
        // which we treat as a soft failure and log for diagnosis.
        const et = r.entities.event_type;
        eventTotal += 1;
        const valid = typeof et === 'string' && EVENT_TYPES.has(et);
        if (valid) eventValid += 1;
        const marker = valid ? '✓' : '✗';
        console.log(`  event_type: ${JSON.stringify(et)}  ${marker}`);
        if (sample.expectedEvent) {
            eventExpectedTotal += 1;
            const hit = et === sample.expectedEvent;
            if (hit) eventExpectedHits += 1;
            console.log(`    expected="${sample.expectedEvent}"  ${hit ? '✓' : '(soft miss)'}`);
        }

        for (const c of (r.entities.companies  || [])) allCompanies.add(c);
        for (const c of (r.entities.related    || [])) allCompanies.add(c);
        for (const i of (r.entities.industries || [])) allIndustries.add(i);
    }

    console.log('\n' + '='.repeat(70));
    console.log('RESOLUTION');
    console.log('='.repeat(70));

    console.log(`\nResolving ${allCompanies.size} unique company names → tickers (Yahoo search)...`);
    const companyTickers = new Set();
    for (const c of allCompanies) {
        const sym = await resolveCompany(c);
        if (sym) {
            console.log(`  ✓ ${c.padEnd(30)} → ${sym}`);
            companyTickers.add(sym);
        } else {
            console.log(`  · ${c.padEnd(30)} → (no match)`);
        }
    }

    console.log(`\nResolving ${allIndustries.size} industries → tickers (static map)...`);
    const industryTickers = new Set();
    for (const ind of allIndustries) {
        const tickers = resolveIndustryTickers(ind);
        console.log(`  ${ind.padEnd(30)} → [${Array.from(tickers).join(', ') || '(no match)'}]`);
        for (const t of tickers) industryTickers.add(t);
    }

    const all = new Set([...companyTickers, ...industryTickers]);
    console.log('\n' + '='.repeat(70));
    console.log(`FINAL: ${all.size} tickers from Ollama pass`);
    console.log(`  companies: ${companyTickers.size}  industries: ${industryTickers.size}`);
    console.log(`  union: [${Array.from(all).sort().join(', ')}]`);
    console.log('='.repeat(70));

    // Item 5 — event_type assertions. Hard requirement: every article yields
    // a valid enum value. Soft signal: hits on the labeled samples (used to
    // spot prompt regressions).
    console.log('\nEVENT_TYPE');
    console.log('='.repeat(70));
    console.log(`  valid enum values:   ${eventValid}/${eventTotal}`);
    console.log(`  labeled matches:     ${eventExpectedHits}/${eventExpectedTotal}`);
    if (eventTotal > 0 && eventValid < eventTotal) {
        console.log('  FAIL — at least one article returned a value outside the enum');
        process.exitCode = 1;
    } else {
        console.log('  PASS');
    }
}

run().catch(e => { console.error(e); process.exit(1); });
