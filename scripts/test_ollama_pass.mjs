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

const PROMPT_TEMPLATE = `You are a financial analyst. Read this news article and extract:
1. Any company names mentioned (public or private)
2. Any industries or sectors discussed
3. Any companies mentioned as suppliers, customers, or competitors
Respond ONLY with valid JSON in this exact shape:
{"companies":["Apple Inc","TSMC"],"industries":["semiconductor","consumer electronics"],"related":["Foxconn","Samsung"]}
Article:
`;

// Sample articles chosen to exercise:
//   1. Explicit company without ticker → company resolver must find AAPL
//   2. Industry-only mention → industry map must return SMH + holdings
//   3. Supplier/competitor language → "related" entities should surface
const SAMPLES = [
    {
        label: 'company-by-name',
        text:  'Apple announced a record quarter Tuesday, driven by stronger-than-expected iPhone sales in China. CEO Tim Cook said services revenue also hit an all-time high.',
    },
    {
        label: 'industry-only',
        text:  'The semiconductor industry is bracing for a global chip shortage extending into next year, analysts at major investment banks warned this week. Demand from AI data centers continues to outstrip supply.',
    },
    {
        label: 'supplier-relationship',
        text:  'Tesla supplier Panasonic said it will expand battery production at its Nevada gigafactory. The move comes as Tesla competitors Ford and General Motors race to scale their own EV manufacturing.',
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
            options: { temperature: 0, num_predict: 200 },
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
}

run().catch(e => { console.error(e); process.exit(1); });
