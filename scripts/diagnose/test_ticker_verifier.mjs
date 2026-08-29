// Regression test for the Ollama ticker-resolution verifier (TICKER-RESOLUTION VERIFIER).
// Tests that verifyTickerMatch() correctly accepts known-good (company/symbol) pairs
// and rejects known-bad ones (name-overlap false positives like Apple → APLE).
//
// Requires Ollama running locally with OLLAMA_ENABLED=true.
//
// Run: OLLAMA_ENABLED=true node --experimental-strip-types scripts/test_ticker_verifier.mjs

import { verifyTickerMatch, isOllamaEnabled, checkOllamaReachable } from '../../src/utils/ollamaTicker.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Known-bad: the article is clearly about a different company than the candidate.
const BAD_FIXTURES = [
    {
        label: 'Apple Inc article → APLE (Apple Hospitality REIT)',
        companyName:     'Apple',
        candidateSymbol: 'APLE',
        longName:        'Apple Hospitality REIT Inc',
        articleSlice:    'Apple Inc. reported record quarterly earnings on Tuesday, with iPhone sales beating analyst expectations. CEO Tim Cook said services revenue also hit an all-time high. The Cupertino-based company said Mac and iPad sales rose 12% year-over-year.',
        expectedMatch:   false,
    },
    {
        label: 'Amazon (retailer) article → AMZN confused with AMC Networks',
        companyName:     'Amazon',
        candidateSymbol: 'AMCX',
        longName:        'AMC Networks Inc',
        articleSlice:    'Amazon announced a major expansion of its Prime delivery network on Wednesday, adding 50 new fulfillment centers across the US. CEO Andy Jassy said the investment underscores Amazon\'s commitment to next-day delivery.',
        expectedMatch:   false,
    },
    {
        label: 'Tesla article → TSLA confused with Tesltra (Australian telecom)',
        companyName:     'Tesla',
        candidateSymbol: 'TLS',
        longName:        'Telstra Corporation Limited',
        articleSlice:    'Tesla unveiled its latest Model Y refresh at a packed event in Fremont, California. CEO Elon Musk said the updated electric vehicle will ship with enhanced Autopilot software as standard.',
        expectedMatch:   false,
    },
    {
        label: 'Microsoft article → MSFT confused with ManpowerGroup (MAN)',
        companyName:     'Microsoft',
        candidateSymbol: 'MAN',
        longName:        'ManpowerGroup Inc',
        articleSlice:    'Microsoft reported its fiscal Q3 earnings after the close, beating Wall Street estimates on Azure cloud revenue. CEO Satya Nadella highlighted Copilot AI integration across the Office 365 suite.',
        expectedMatch:   false,
    },
];

// Known-good: the article is clearly about the candidate company.
const GOOD_FIXTURES = [
    {
        label: 'Apple Inc article → AAPL',
        companyName:     'Apple',
        candidateSymbol: 'AAPL',
        longName:        'Apple Inc.',
        articleSlice:    'Apple Inc. reported record quarterly earnings on Tuesday, with iPhone sales beating analyst expectations. CEO Tim Cook said services revenue also hit an all-time high. The Cupertino-based company said Mac and iPad sales rose 12% year-over-year.',
        expectedMatch:   true,
    },
    {
        label: 'Tesla article → TSLA',
        companyName:     'Tesla',
        candidateSymbol: 'TSLA',
        longName:        'Tesla Inc.',
        articleSlice:    'Tesla unveiled its latest Model Y refresh at a packed event in Fremont, California. CEO Elon Musk said the updated electric vehicle will ship with enhanced Autopilot software as standard.',
        expectedMatch:   true,
    },
    {
        label: 'Nvidia article → NVDA',
        companyName:     'Nvidia',
        candidateSymbol: 'NVDA',
        longName:        'NVIDIA Corporation',
        articleSlice:    'Nvidia shares surged 8% on Thursday after the chipmaker reported blowout data-center GPU demand. CEO Jensen Huang said demand for H100 chips continues to far outpace supply.',
        expectedMatch:   true,
    },
    {
        label: 'Amazon article → AMZN',
        companyName:     'Amazon',
        candidateSymbol: 'AMZN',
        longName:        'Amazon.com Inc.',
        articleSlice:    'Amazon announced a major expansion of its Prime delivery network on Wednesday, adding 50 new fulfillment centers across the US. CEO Andy Jassy said the investment underscores Amazon\'s commitment to next-day delivery.',
        expectedMatch:   true,
    },
    {
        label: 'Microsoft article → MSFT',
        companyName:     'Microsoft',
        candidateSymbol: 'MSFT',
        longName:        'Microsoft Corporation',
        articleSlice:    'Microsoft reported its fiscal Q3 earnings after the close, beating Wall Street estimates on Azure cloud revenue. CEO Satya Nadella highlighted Copilot AI integration across the Office 365 suite.',
        expectedMatch:   true,
    },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runFixture(f) {
    const t0 = Date.now();
    let result;
    let error = null;
    try {
        result = await verifyTickerMatch(f.articleSlice, f.companyName, f.candidateSymbol, f.longName);
    } catch (e) {
        error = e;
        result = null;
    }
    const elapsed = Date.now() - t0;
    const correct = result === f.expectedMatch;
    const marker  = correct ? '✓' : '✗';
    const got     = result === null ? 'ERROR' : String(result);
    console.log(`  [${marker}] ${f.label}`);
    console.log(`       got=${got}  expected=${f.expectedMatch}  elapsed=${elapsed}ms`);
    if (error) console.log(`       error: ${error.message}`);
    return { correct, result, expected: f.expectedMatch };
}

async function run() {
    console.log('='.repeat(70));
    console.log('TICKER-RESOLUTION VERIFIER — regression test');
    console.log('='.repeat(70));

    if (!isOllamaEnabled()) {
        console.log('\nSKIP — OLLAMA_ENABLED is not set to "true"');
        console.log('Re-run with:  OLLAMA_ENABLED=true node --experimental-strip-types scripts/test_ticker_verifier.mjs');
        process.exit(0);
    }

    const reachable = await checkOllamaReachable();
    if (!reachable) {
        console.log('\nFAIL — Ollama is not reachable. Start it first.');
        process.exit(1);
    }
    console.log('\nOllama: reachable ✓\n');

    let badPass = 0, badFail = 0;
    console.log('KNOWN-BAD fixtures (verifier should return false):');
    for (const f of BAD_FIXTURES) {
        const { correct } = await runFixture(f);
        if (correct) badPass++; else badFail++;
    }

    let goodPass = 0, goodFail = 0;
    console.log('\nKNOWN-GOOD fixtures (verifier should return true):');
    for (const f of GOOD_FIXTURES) {
        const { correct } = await runFixture(f);
        if (correct) goodPass++; else goodFail++;
    }

    const total  = BAD_FIXTURES.length + GOOD_FIXTURES.length;
    const passed = badPass + goodPass;
    console.log('\n' + '='.repeat(70));
    console.log(`RESULT: ${passed}/${total} correct`);
    console.log(`  Known-bad  (reject): ${badPass}/${BAD_FIXTURES.length}`);
    console.log(`  Known-good (accept): ${goodPass}/${GOOD_FIXTURES.length}`);

    if (badFail > 0 || goodFail > 0) {
        console.log('\nFAIL — verifier did not match all expected outcomes.');
        process.exitCode = 1;
    } else {
        console.log('\nPASS');
    }
}

run().catch(e => { console.error(e); process.exit(1); });
