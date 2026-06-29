import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { createLogger } from '@/utils/logger';

const logger = createLogger('utils/aiNewsExtractor');

export interface RawArticle {
    title: string;
    description: string;
    source: string;
}

export interface AiTickerMention {
    ticker: string;
    company: string;
    confidence: 'high' | 'medium' | 'low';
}

const TickerMentionSchema = z.object({
    ticker: z.string().min(1).max(6),
    company: z.string().min(1).max(120),
    confidence: z.enum(['high', 'medium', 'low']),
});
const ExtractionResultSchema = z.object({
    mentions: z.array(TickerMentionSchema),
});

const MODEL = 'claude-sonnet-4-6';
const MAX_ARTICLES_PER_CALL = 60;
const CALL_TIMEOUT_MS = 30_000;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
}

/**
 * Extract ticker/company mentions from raw news articles using Claude, to
 * catch companies discussed by name without an explicit ticker symbol
 * (which the regex-based TICKER_PATTERNS pass in route.ts misses entirely).
 * Fails soft everywhere: missing key, malformed response, timeout, or any
 * thrown error all resolve to an empty array rather than propagating, since
 * a discovery-route failure aborts the whole deepmoney_sync run.
 */
export async function extractTickersFromArticles(articles: RawArticle[]): Promise<AiTickerMention[]> {
    const anthropic = getClient();
    if (!anthropic || articles.length === 0) return [];

    const chunks: RawArticle[][] = [];
    for (let i = 0; i < articles.length; i += MAX_ARTICLES_PER_CALL) {
        chunks.push(articles.slice(i, i + MAX_ARTICLES_PER_CALL));
    }

    const results = await Promise.allSettled(chunks.map((chunk) => extractChunk(anthropic, chunk)));

    const merged: AiTickerMention[] = [];
    for (const r of results) {
        if (r.status === 'fulfilled') merged.push(...r.value);
        else logger.warn('AI extraction chunk failed', { error: String(r.reason) });
    }
    return merged;
}

async function extractChunk(anthropic: Anthropic, articles: RawArticle[]): Promise<AiTickerMention[]> {
    try {
        const numbered = articles
            .map((a, i) => `[${i}] ${a.title}\n${a.description}`.slice(0, 800))
            .join('\n\n');

        const response = await anthropic.messages.create(
            {
                model: MODEL,
                max_tokens: 2048,
                tools: [{
                    name: 'record_ticker_mentions',
                    description: 'Record every publicly-traded US stock ticker/company mentioned in the articles, including companies named without an explicit ticker symbol.',
                    input_schema: {
                        type: 'object',
                        properties: {
                            mentions: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        ticker: { type: 'string', description: 'Upper-case stock ticker, e.g. AAPL' },
                                        company: { type: 'string' },
                                        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                                    },
                                    required: ['ticker', 'company', 'confidence'],
                                },
                            },
                        },
                        required: ['mentions'],
                    },
                }],
                tool_choice: { type: 'tool', name: 'record_ticker_mentions' },
                messages: [{
                    role: 'user',
                    content: `Extract every US-listed public company ticker mentioned or implied by name in these news items:\n\n${numbered}`,
                }],
            },
            { timeout: CALL_TIMEOUT_MS },
        );

        const toolUse = response.content.find((b) => b.type === 'tool_use');
        if (!toolUse) return [];

        const parsed = ExtractionResultSchema.safeParse(toolUse.input);
        if (!parsed.success) {
            logger.warn('AI extraction response failed schema validation', { error: parsed.error.message });
            return [];
        }
        return parsed.data.mentions;
    } catch (err) {
        logger.warn('AI ticker extraction call failed', { error: String(err) });
        return [];
    }
}
