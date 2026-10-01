import { describe, expect, test } from 'bun:test';
import {
  installBenchRouterSynopsisRouting,
  resolveSynopsisModel,
  loadEvalPack,
  loadFixture,
  validateChunkBudget,
  validateStaticInputs,
} from '../../eval/runner/benchrouter-contextual-synopsis.ts';

describe('BenchRouter contextual synopsis fixture validation', () => {
  test('amara-life-v1 eval pack, input refs, and label completeness validate offline', () => {
    const pack = loadEvalPack();
    const fixture = loadFixture('amara-life-v1');
    expect(pack.primary_metric).toBe('recall_at_5');
    expect(fixture.pages.length).toBe(424);
    expect(fixture.queries.length).toBe(93);
    expect(new Set(fixture.queries.flatMap(q => q.relevant_slugs)).size).toBe(110);
    expect(() => validateStaticInputs(pack, fixture, false)).not.toThrow();
    expect(() => validateStaticInputs(pack, fixture, true)).not.toThrow();
  });

  test('a missing label fails the evidence check', () => {
    const pack = loadEvalPack();
    const fixture = loadFixture('amara-life-v1');
    const conflict = fixture.queries.find(q => q.id === 'conflict-meridian-solar-series-a')!;
    conflict.relevant_slugs = conflict.relevant_slugs.slice(0, 1);
    expect(() => validateStaticInputs(pack, fixture, false)).toThrow('labels disagree with its evidence');
  });

  test('amara-life-v1 imports as 424 single-chunk pages within the call budget', async () => {
    const pack = loadEvalPack();
    const stats = await validateChunkBudget(pack, loadFixture('amara-life-v1'));
    expect(stats.totalChunks).toBe(424);
    expect(pack.max_model_calls).toBeGreaterThanOrEqual(stats.totalChunks);
  });

  test('the historical cat26 fixture stays valid for local reproduction', async () => {
    const pack = loadEvalPack();
    const fixture = loadFixture('cat26');
    validateStaticInputs(pack, fixture, false);
    const stats = await validateChunkBudget(pack, fixture);
    expect(fixture.queries.length).toBe(35);
    expect(stats.totalChunks).toBe(30);
  });
});


describe('RUN-001 / AUTH-010 native executable transport', () => {
  test('missing or blank runtime call token is refused', () => {
    const oldBase = process.env.BENCHROUTER_EVAL_BASE_URL;
    const oldToken = process.env.BENCHROUTER_API_KEY;
    const oldAnthropicBase = process.env.ANTHROPIC_BASE_URL;
    try {
      process.env.BENCHROUTER_EVAL_BASE_URL = 'http://127.0.0.1:1';
      delete process.env.BENCHROUTER_API_KEY;
      expect(() => installBenchRouterSynopsisRouting()).toThrow('BENCHROUTER_API_KEY');
      process.env.BENCHROUTER_API_KEY = '  ';
      expect(() => installBenchRouterSynopsisRouting()).toThrow('BENCHROUTER_API_KEY');
    } finally {
      if (oldBase === undefined) delete process.env.BENCHROUTER_EVAL_BASE_URL;
      else process.env.BENCHROUTER_EVAL_BASE_URL = oldBase;
      if (oldToken === undefined) delete process.env.BENCHROUTER_API_KEY;
      else process.env.BENCHROUTER_API_KEY = oldToken;
      if (oldAnthropicBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = oldAnthropicBase;
    }
  });

  test('opaque runtime token reaches the real pinned native SDK at the route endpoint', async () => {
    const { chat, configureGateway } = await import('gbrain/ai/gateway');
    // Recorded Anthropic wire fixture from BenchRouter test/fixtures/anthropic/message.json.
    // Use real loopback HTTP and the installed SDK, with no provider call or fetch override.
    const fixture = await Bun.file('test/fixtures/anthropic/message.json').text();
    const observed: { path: string; apiKey: string | null; model: unknown }[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as { model?: unknown };
      observed.push({ path: new URL(request.url).pathname, apiKey: request.headers.get('x-api-key'), model: body.model });
      return new Response(fixture, { headers: { 'content-type': 'application/json' } });
    } });
    const names = ['BENCHROUTER_EVAL_BASE_URL', 'BENCHROUTER_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'] as const;
    const before = names.map(name => process.env[name]);
    try {
      process.env.BENCHROUTER_EVAL_BASE_URL = `http://127.0.0.1:${server.port}/`;
      process.env.BENCHROUTER_API_KEY = ' opaque-native-call-token ';
      configureGateway({ env: process.env as Record<string, string | undefined> });
      installBenchRouterSynopsisRouting();
      const response = await chat({ model: resolveSynopsisModel(true), messages: [{ role: 'user', content: 'Local transport proof' }], maxTokens: 40, abortSignal: AbortSignal.timeout(2_000) });
      expect(response.text).toBe('XXXXXXXXXXXXXXXXXXXX');
      expect(observed).toEqual([{ path: '/v1/messages', apiKey: 'opaque-native-call-token', model: 'gbrain-evals/contextual-synopsis' }]);
      expect(process.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${server.port}/v1`);
      expect(resolveSynopsisModel(false)).toBe(process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL ?? 'anthropic:claude-haiku-4-5-20251001');
    } finally {
      server.stop(true);
      names.forEach((name, i) => {
        if (before[i] === undefined) delete process.env[name];
        else process.env[name] = before[i];
      });
    }
  });
});
