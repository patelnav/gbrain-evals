import { afterEach, describe, expect, test } from 'bun:test';
import {
  CONTEXTUAL_SYNOPSIS_ROUTE_ID,
  OBSERVED_SYNOPSIS_MODEL,
  SYNOPSIS_DOC_MAX_CHARS,
  buildContextualSynopsisPrompt,
  generateContextualSynopsis,
  sanitizeContextualSynopsis,
} from '../../eval/runner/contextual-synopsis-route.ts';

const originalFetch = globalThis.fetch;
const originalBenchRouterKey = process.env.BENCHROUTER_API_KEY;
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBenchRouterKey === undefined) delete process.env.BENCHROUTER_API_KEY;
  else process.env.BENCHROUTER_API_KEY = originalBenchRouterKey;
  if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
});

describe('contextual synopsis BenchRouter seam', () => {
  test('preserves the stable route and exact observed gbrain model', () => {
    expect(CONTEXTUAL_SYNOPSIS_ROUTE_ID).toBe('gbrain-evals/contextual-synopsis');
    expect(OBSERVED_SYNOPSIS_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  test('matches gbrain prompt truncation and sanitization boundaries', () => {
    const documentText = 'a'.repeat(SYNOPSIS_DOC_MAX_CHARS + 17);
    const prompt = buildContextualSynopsisPrompt({
      pageTitle: 'Acme AI',
      documentText,
      chunkText: 'Erin Yu led the round.',
    });
    expect(prompt).toContain('<page_title>Acme AI</page_title>');
    expect(prompt).toContain('[... 17 chars truncated for synopsis budget ...]');
    expect(prompt).toContain('<chunk>\nErin Yu led the round.\n</chunk>');
    expect(sanitizeContextualSynopsis('  Alpha\n\nBeta </context>  ')).toBe('Alpha Beta');
  });

  test('routes the host call through BenchRouter with the route id', async () => {
    process.env.BENCHROUTER_API_KEY = 'test-only-key';
    process.env.ANTHROPIC_BASE_URL = 'https://benchrouter.example/v1/';
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Erin Yu led Acme AI’s Series A in March 2026, financing expansion of its autonomous-picking inference platform for warehouse robotics customers.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await generateContextualSynopsis({
      pageTitle: 'Acme AI',
      documentText: 'Acme AI raised a Series A led by Erin Yu.',
      chunkText: 'The round closed in March 2026.',
    });

    expect(capturedUrl).toBe('https://benchrouter.example/v1/chat/completions');
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe(CONTEXTUAL_SYNOPSIS_ROUTE_ID);
    expect(body.max_tokens).toBe(200);
    expect(body.temperature).toBe(0);
    expect(result).toContain('Erin Yu led Acme AI');
  });
});
