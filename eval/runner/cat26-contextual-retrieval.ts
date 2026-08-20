/**
 * BrainBench Cat 26 — contextual retrieval modes A/B (v0.40.3.0).
 *
 * Headline question: does Anthropic-style contextual retrieval
 * (`title` wrap or `per_chunk_synopsis`) actually improve recall on
 * cross-chunk queries?
 *
 * Fixed corpus selected from the committed world-v1 fixtures.
 *
 * Flow:
 *   1. Fixed corpus (15 existing world-v1 pages).
 *   2. Three modes: none, title, per_chunk_synopsis.
 *   3. Ten queries with gold slugs.
 *   4. For each (mode, query) measure Recall@1, Recall@5, and Recall@10.
 *   5. Report mode-vs-mode delta.
 *
 * BenchRouter repository_executable mode (`--benchrouter` or
 * BENCHROUTER_EXEC_RESULT_PATH) runs only the routed synopsis path:
 *   - Synopsis uses gbrain native Anthropic Messages via ANTHROPIC_BASE_URL
 *   - Outbound model is `anthropic:<route-id>` (unprefixed route id in body)
 *   - Forced candidate belongs only in BENCHROUTER_EVAL_HEADERS_JSON
 *   - Embeddings stay on google:gemini-embedding-001 at 1,536 dimensions
 *   - Captures x-benchrouter-model-call-id from /v1/messages responses only
 *   - Synopsis page_fallback fails the eval
 *   - Writes benchrouter.executable_result.v1 to result_path
 *
 * Run:
 *   bun eval/runner/cat26-contextual-retrieval.ts
 *   bun eval/runner/cat26-contextual-retrieval.ts --benchrouter
 *   bun eval/runner/cat26-contextual-retrieval.ts --validate
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import { reembedPageWithContextualRetrieval } from '../../node_modules/gbrain/src/core/contextual-retrieval-service.ts';
import { recallAtK, type RankedDoc } from './types.ts';

const CORPUS_PATH = 'eval/data/cat26-contextual-retrieval/corpus.json';
const QUERIES_PATH = 'eval/data/cat26-contextual-retrieval/queries.json';
const EVAL_PACK_PATH = '.benchrouter/contextual-synopsis-eval-pack.json';
const ROUTE_ID = 'gbrain-evals/contextual-synopsis';
const INCUMBENT_SYNOPSIS_MODEL = 'anthropic:claude-haiku-4-5-20251001';
const EMBEDDING_MODEL = 'google:gemini-embedding-001';
const EMBEDDING_DIM = 1536;
const PRIMARY_METRIC = 'recall_at_1';

const MIN_PAGES = 12;
const MIN_QUERIES = 8;
const MIN_TOTAL_CHUNKS = 15;
const MIN_CONTEXTUAL_GOLD_PAGES = 4;

interface CorpusPage {
  slug: string;
  title: string;
  body: string;
}

interface CorpusFile {
  schema_version: number;
  source: 'world-v1';
  page_refs: string[];
}

interface WorldPage {
  slug: string;
  title: string;
  compiled_truth: string;
  timeline?: string;
}

interface LoadedCorpus {
  pages: CorpusPage[];
  pageRefs: string[];
}

interface QuerySpec {
  id: string;
  query: string;
  relevant_slugs: string[];
}

interface QueriesFile {
  schema_version: number;
  queries: QuerySpec[];
}

interface EvalPack {
  mode: string;
  id?: string;
  primary_metric: string;
  result_path: string;
  max_model_calls: number;
  input_refs: string[];
  acceptance_refs: string[];
  case_refs?: string[];
  secret_env?: string[];
  lockfile?: string;
  result_schema?: string;
}

type Mode = 'none' | 'title' | 'per_chunk_synopsis';

interface ModeResult {
  mode: Mode;
  per_query_recall_at_1: number[];
  per_query_recall_at_5: number[];
  per_query_recall_at_10: number[];
  mean_recall_at_1: number;
  mean_recall_at_5: number;
  mean_recall_at_10: number;
}

interface Receipt {
  schema_version: 1;
  cat: 'cat26-contextual-retrieval';
  gbrain_version: string;
  timestamp: string;
  corpus_pages: number;
  queries: number;
  modes: ModeResult[];
  best_mode: Mode;
  none_vs_title_delta_at_5: number;
  none_vs_synopsis_delta_at_5: number;
  none_vs_title_delta_at_10: number;
  none_vs_synopsis_delta_at_10: number;
}

interface BenchRouterExecutableResult {
  schema_version: 'benchrouter.executable_result.v1';
  primary_metric: { name: string; score: number };
  metrics: Record<string, number>;
  model_call_ids: string[];
  observations: Array<{
    id: string;
    version: string;
    critical: boolean;
    pass: boolean;
    score: number;
  }>;
}

interface ParsedArgs {
  help: boolean;
  validate: boolean;
  benchrouter: boolean;
  modes: Mode[];
  resultPath?: string;
}

interface FixtureStats {
  totalChunks: number;
  perPageChunks: Record<string, number>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    help: false,
    validate: false,
    benchrouter: false,
    modes: ['none', 'title', 'per_chunk_synopsis'],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--validate') out.validate = true;
    else if (arg === '--benchrouter') out.benchrouter = true;
    else if (arg === '--modes') out.modes = argv[++i].split(',').map(s => s.trim()) as Mode[];
    else if (arg === '--result-path') out.resultPath = argv[++i];
  }
  if (process.env.BENCHROUTER_EXEC_RESULT_PATH) {
    out.benchrouter = true;
    out.resultPath = process.env.BENCHROUTER_EXEC_RESULT_PATH;
    out.modes = ['per_chunk_synopsis'];
  }
  return out;
}

function printHelp(): void {
  process.stderr.write(
    'cat26-contextual-retrieval — fixed-corpus contextual retrieval benchmark\n\n' +
    'Usage:\n' +
    '  bun eval/runner/cat26-contextual-retrieval.ts [--validate]\n' +
    '  bun eval/runner/cat26-contextual-retrieval.ts --benchrouter [--result-path PATH]\n' +
    '  bun eval/runner/cat26-contextual-retrieval.ts --modes none,title\n\n' +
    'Flags:\n' +
    '  --validate       Check corpus, queries, eval-pack, and chunk invariants (no network)\n' +
    '  --benchrouter    BenchRouter repository_executable mode (synopsis route only)\n' +
    '  --result-path    Override benchrouter.executable_result.v1 output path\n' +
    '  --modes          Comma-separated modes (default: none,title,per_chunk_synopsis)\n',
  );
}

function loadCorpus(): LoadedCorpus {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as CorpusFile;
  if (raw.source !== 'world-v1' || !Array.isArray(raw.page_refs) || raw.page_refs.length === 0) {
    throw new Error(`${CORPUS_PATH}: expected a non-empty world-v1 page_refs array`);
  }
  const pages = raw.page_refs.map((ref): CorpusPage => {
    const page = JSON.parse(readFileSync(ref, 'utf8')) as WorldPage;
    if (!page.slug?.trim() || !page.title?.trim() || !page.compiled_truth?.trim()) {
      throw new Error(`${ref}: expected slug, title, and compiled_truth`);
    }
    const timeline = page.timeline?.trim();
    return {
      slug: page.slug,
      title: page.title,
      body: timeline
        ? `${page.compiled_truth}\n\n## Timeline\n\n${timeline}`
        : page.compiled_truth,
    };
  });
  return { pages, pageRefs: raw.page_refs };
}

function loadQueries(): QuerySpec[] {
  const raw = JSON.parse(readFileSync(QUERIES_PATH, 'utf8')) as QueriesFile;
  if (!Array.isArray(raw.queries) || raw.queries.length === 0) {
    throw new Error(`${QUERIES_PATH}: missing queries array`);
  }
  return raw.queries;
}

function loadEvalPack(): EvalPack {
  const raw = JSON.parse(readFileSync(EVAL_PACK_PATH, 'utf8')) as EvalPack;
  if (raw.mode !== 'repository_executable') {
    throw new Error(`${EVAL_PACK_PATH}: mode must be repository_executable`);
  }
  return raw;
}

function normalizeAnthropicBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseEvalHeaders(): Record<string, string> {
  const headersJson = process.env.BENCHROUTER_EVAL_HEADERS_JSON;
  if (!headersJson) return {};
  const parsed = JSON.parse(headersJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('BENCHROUTER_EVAL_HEADERS_JSON must be a JSON object');
  }
  return parsed as Record<string, string>;
}

const modelCallIds: string[] = [];
let benchRouterRoutingInstalled = false;

/**
 * BenchRouter synopsis routing preserves native Anthropic Messages:
 * ANTHROPIC_BASE_URL → eval base; outbound model stays anthropic:<route-id>.
 * Embeddings retain the gateway's fixed Google configuration and receive no
 * BenchRouter eval headers.
 */
function installBenchRouterSynopsisRouting(): void {
  if (benchRouterRoutingInstalled) return;
  benchRouterRoutingInstalled = true;

  const evalBaseRaw = process.env.BENCHROUTER_EVAL_BASE_URL?.trim();
  if (!evalBaseRaw) {
    throw new Error('BENCHROUTER_EVAL_BASE_URL is required in --benchrouter mode');
  }
  const evalBaseUrl = normalizeAnthropicBaseUrl(evalBaseRaw);
  const evalOrigin = new URL(evalBaseUrl).origin;

  process.env.ANTHROPIC_BASE_URL = evalBaseUrl;
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    process.env.ANTHROPIC_API_KEY = 'benchrouter-eval-dummy';
  }

  const evalHeaders = parseEvalHeaders();
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = new URL(resolveUrl(input));
    const isAnthropicMessages =
      requestUrl.origin === evalOrigin && requestUrl.pathname === '/v1/messages';

    if (!isAnthropicMessages) {
      return originalFetch(input, init);
    }

    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(evalHeaders)) {
      if (typeof value === 'string' && value.length > 0) headers.set(key, value);
    }
    const response = await originalFetch(input, { ...init, headers });
    const callId = response.headers.get('x-benchrouter-model-call-id');
    if (callId && !modelCallIds.includes(callId)) {
      modelCallIds.push(callId);
    }
    return response;
  };
}

/**
 * Outbound synopsis model for BenchRouter: anthropic transport + route id body.
 * BENCHROUTER_FORCE_MODEL is never used here — forced candidate belongs in headers.
 */
function resolveSynopsisModel(benchrouter: boolean): string {
  if (benchrouter) {
    return `anthropic:${ROUTE_ID}`;
  }
  return process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL ?? INCUMBENT_SYNOPSIS_MODEL;
}

function configureEmbeddingGateway(): void {
  configureGateway({
    embedding_model: EMBEDDING_MODEL,
    embedding_dimensions: EMBEDDING_DIM,
    env: process.env as Record<string, string | undefined>,
  });
}

function toRankedDocs(results: Array<{ slug: string; score?: number }>): RankedDoc[] {
  const seen = new Set<string>();
  const docs: RankedDoc[] = [];
  for (const result of results) {
    if (seen.has(result.slug)) continue;
    seen.add(result.slug);
    docs.push({
      page_id: result.slug,
      score: typeof result.score === 'number' ? result.score : 0,
      rank: docs.length + 1,
    });
  }
  return docs;
}

async function measureFixtureChunks(pages: CorpusPage[]): Promise<FixtureStats> {
  const engine = new PGLiteEngine() as PGLiteEngine;
  try {
    await engine.connect({});
    await engine.initSchema();
    const perPageChunks: Record<string, number> = {};
    let totalChunks = 0;
    for (const page of pages) {
      const body = `# ${page.title}\n\n${page.body}\n`;
      await importFromContent(engine, page.slug, body, { noEmbed: true });
      const chunks = await engine.getChunks(page.slug, { sourceId: 'default' });
      perPageChunks[page.slug] = chunks.length;
      totalChunks += chunks.length;
    }
    return { totalChunks, perPageChunks };
  } finally {
    await engine.disconnect();
  }
}

function validateEvalPackContract(pack: EvalPack): void {
  if (pack.primary_metric !== PRIMARY_METRIC) {
    throw new Error(`eval-pack primary_metric must be ${PRIMARY_METRIC}, got ${pack.primary_metric}`);
  }
  if (pack.result_schema && pack.result_schema !== 'benchrouter.executable_result.v1') {
    throw new Error('eval-pack result_schema must be benchrouter.executable_result.v1');
  }
  if (!pack.result_path?.trim()) {
    throw new Error('eval-pack result_path is required');
  }
  if (!Number.isFinite(pack.max_model_calls) || pack.max_model_calls <= 0) {
    throw new Error('eval-pack max_model_calls must be a positive number');
  }
  if (!Array.isArray(pack.input_refs) || pack.input_refs.length === 0) {
    throw new Error('eval-pack input_refs must be a non-empty array');
  }
  if (!Array.isArray(pack.acceptance_refs) || pack.acceptance_refs.length === 0) {
    throw new Error('eval-pack acceptance_refs must be a non-empty array');
  }
  for (const ref of pack.input_refs) {
    if (pack.acceptance_refs.includes(ref)) {
      throw new Error(`eval-pack input_refs and acceptance_refs must be disjoint; both list ${ref}`);
    }
  }
  if (pack.secret_env?.includes('ANTHROPIC_API_KEY')) {
    throw new Error('eval-pack secret_env must not require ANTHROPIC_API_KEY');
  }
  if (!pack.secret_env?.includes('GOOGLE_GENERATIVE_AI_API_KEY')) {
    throw new Error('eval-pack secret_env must require GOOGLE_GENERATIVE_AI_API_KEY');
  }
  if (pack.secret_env?.includes('OPENAI_API_KEY')) {
    throw new Error('eval-pack secret_env must not require OPENAI_API_KEY');
  }
  if (pack.lockfile) readFileSync(pack.lockfile, 'utf8');
}

function validateQueries(queries: QuerySpec[], pages: CorpusPage[]): void {
  const slugs = new Set(pages.map(p => p.slug));
  const ids = new Set<string>();
  for (const q of queries) {
    if (!q.id?.trim()) throw new Error('each query requires a non-empty id');
    if (ids.has(q.id)) throw new Error(`duplicate query id: ${q.id}`);
    ids.add(q.id);
    if (!q.query?.trim()) throw new Error(`query ${q.id} requires non-empty query text`);
    if (!Array.isArray(q.relevant_slugs) || q.relevant_slugs.length === 0) {
      throw new Error(`query ${q.id} requires at least one relevant_slug`);
    }
    for (const slug of q.relevant_slugs) {
      if (!slugs.has(slug)) {
        throw new Error(`query ${q.id} references unknown slug: ${slug}`);
      }
    }
  }
}

function validateFixtureInvariants(pages: CorpusPage[], queries: QuerySpec[], stats: FixtureStats): void {
  if (pages.length < MIN_PAGES) {
    throw new Error(`corpus must have at least ${MIN_PAGES} pages (got ${pages.length})`);
  }
  if (queries.length < MIN_QUERIES) {
    throw new Error(`queries must have at least ${MIN_QUERIES} entries (got ${queries.length})`);
  }
  if (stats.totalChunks < MIN_TOTAL_CHUNKS) {
    throw new Error(`corpus must produce at least ${MIN_TOTAL_CHUNKS} chunks (got ${stats.totalChunks})`);
  }
  if (pages.length <= 10) {
    throw new Error(`Recall@10 needs more than ten competing pages (got ${pages.length})`);
  }
  const goldPages = new Set(queries.flatMap(query => query.relevant_slugs));
  if (goldPages.size < MIN_CONTEXTUAL_GOLD_PAGES) {
    throw new Error(
      `contextual retrieval needs at least ${MIN_CONTEXTUAL_GOLD_PAGES} unique gold pages (got ${goldPages.size})`,
    );
  }
  for (const slug of goldPages) {
    const chunkCount = stats.perPageChunks[slug] ?? 0;
    if (chunkCount < 2) {
      throw new Error(`contextual retrieval gold page ${slug} must span at least two chunks (got ${chunkCount})`);
    }
  }
}

function validateSynopsisModelRouting(benchrouter: boolean): void {
  const model = resolveSynopsisModel(benchrouter);
  if (!model.startsWith('anthropic:')) {
    throw new Error(`synopsis model must use anthropic: transport (got ${model})`);
  }
  const modelId = model.slice('anthropic:'.length);
  if (benchrouter && modelId !== ROUTE_ID) {
    throw new Error(`benchrouter synopsis model must be anthropic:${ROUTE_ID} (got ${model})`);
  }
  if (benchrouter && process.env.BENCHROUTER_FORCE_MODEL) {
    const forced = process.env.BENCHROUTER_FORCE_MODEL;
    if (model.includes(forced) || forced.includes(modelId)) {
      throw new Error('BENCHROUTER_FORCE_MODEL must not appear in synopsis model; use eval headers only');
    }
  }
}

async function validateFixedInputs(
  pack: EvalPack,
  pages: CorpusPage[],
  pageRefs: string[],
  queries: QuerySpec[],
  benchrouter: boolean,
): Promise<FixtureStats> {
  for (const ref of pack.input_refs) readFileSync(ref, 'utf8');
  for (const ref of pack.acceptance_refs) readFileSync(ref, 'utf8');
  if (pack.case_refs) {
    for (const ref of pack.case_refs) readFileSync(ref, 'utf8');
  }
  validateEvalPackContract(pack);
  for (const ref of pageRefs) {
    if (!pack.input_refs.includes(ref)) {
      throw new Error(`eval-pack input_refs must include corpus page ${ref}`);
    }
  }
  validateQueries(queries, pages);
  const stats = await measureFixtureChunks(pages);
  validateFixtureInvariants(pages, queries, stats);
  validateSynopsisModelRouting(benchrouter);
  return stats;
}

async function applySynopsisReembed(
  engine: PGLiteEngine,
  pages: CorpusPage[],
  synopsisModel: string,
  benchrouter: boolean,
): Promise<void> {
  for (const page of pages) {
    const result = await reembedPageWithContextualRetrieval({
      engine,
      pageSlug: page.slug,
      sourceId: 'default',
      globalMode: 'per_chunk_synopsis',
      synopsisModel,
    });
    if (result.kind === 'transient_error' || result.kind === 'permanent_error') {
      throw new Error(
        `synopsis re-embed failed for ${page.slug}: ${result.kind} ${result.detail}`,
      );
    }
    if (result.kind === 'page_fallback') {
      throw new Error(
        `synopsis re-embed fell back for ${page.slug}: ${result.mode_attempted} → ${result.mode_applied} (${result.fallback_kind})`,
      );
    }
    if (benchrouter && result.kind !== 'success') {
      throw new Error(`unexpected synopsis result for ${page.slug}: ${result.kind}`);
    }
  }
}

async function runMode(
  mode: Mode,
  pages: CorpusPage[],
  queries: QuerySpec[],
  benchrouter: boolean,
): Promise<ModeResult> {
  configureEmbeddingGateway();
  if (benchrouter) {
    installBenchRouterSynopsisRouting();
  }

  const engine = new PGLiteEngine() as PGLiteEngine;
  const origLog = console.log;
  try {
    await engine.connect({});
    await engine.initSchema();
    console.log = () => {};

    await engine.setConfig('contextual_retrieval', mode);
    for (const page of pages) {
      const body = `# ${page.title}\n\n${page.body}\n`;
      await importFromContent(engine, page.slug, body, { noEmbed: false });
    }

    const expectedCalls = (await Promise.all(
      pages.map(page => engine.getChunks(page.slug, { sourceId: 'default' })),
    )).reduce((sum, chunks) => sum + chunks.length, 0);
    const callsBefore = modelCallIds.length;

    if (mode === 'per_chunk_synopsis') {
      await applySynopsisReembed(engine, pages, resolveSynopsisModel(benchrouter), benchrouter);
    }
    if (benchrouter && modelCallIds.length - callsBefore !== expectedCalls) {
      throw new Error(
        `expected ${expectedCalls} BenchRouter synopsis calls, captured ${modelCallIds.length - callsBefore}`,
      );
    }

    const perQ1: number[] = [];
    const perQ5: number[] = [];
    const perQ10: number[] = [];
    for (const q of queries) {
      const results = await hybridSearch(engine, q.query, { limit: 30 } as any);
      const docs = toRankedDocs(results as Array<{ slug: string; score?: number }>).slice(0, 10);
      const rel = new Set(q.relevant_slugs);
      perQ1.push(recallAtK(docs, rel, 1));
      perQ5.push(recallAtK(docs, rel, 5));
      perQ10.push(recallAtK(docs, rel, 10));
    }

    return {
      mode,
      per_query_recall_at_1: perQ1,
      per_query_recall_at_5: perQ5,
      per_query_recall_at_10: perQ10,
      mean_recall_at_1: perQ1.reduce((a, b) => a + b, 0) / Math.max(1, perQ1.length),
      mean_recall_at_5: perQ5.reduce((a, b) => a + b, 0) / Math.max(1, perQ5.length),
      mean_recall_at_10: perQ10.reduce((a, b) => a + b, 0) / Math.max(1, perQ10.length),
    };
  } finally {
    console.log = origLog;
    await engine.disconnect();
  }
}

function writeBenchRouterResult(
  resultPath: string,
  synopsis: ModeResult,
  queries: QuerySpec[],
): void {
  mkdirSync(join(process.cwd(), '.benchrouter'), { recursive: true });
  const observations = queries.map((q, idx) => ({
    id: q.id,
    version: '1',
    critical: false,
    pass: (synopsis.per_query_recall_at_1[idx] ?? 0) > 0,
    score: synopsis.per_query_recall_at_1[idx] ?? 0,
  }));
  const payload: BenchRouterExecutableResult = {
    schema_version: 'benchrouter.executable_result.v1',
    primary_metric: {
      name: PRIMARY_METRIC,
      score: synopsis.mean_recall_at_1,
    },
    metrics: {
      recall_at_1: synopsis.mean_recall_at_1,
      recall_at_5: synopsis.mean_recall_at_5,
      recall_at_10: synopsis.mean_recall_at_10,
    },
    model_call_ids: [...modelCallIds],
    observations,
  };
  writeFileSync(resultPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  process.stderr.write(`[cat26] benchrouter result: ${resultPath}\n`);
  process.stderr.write(`[cat26]   ${PRIMARY_METRIC}=${(synopsis.mean_recall_at_1 * 100).toFixed(1)}%\n`);
  process.stderr.write(`[cat26]   recall_at_5=${(synopsis.mean_recall_at_5 * 100).toFixed(1)}%\n`);
  process.stderr.write(`[cat26]   recall_at_10=${(synopsis.mean_recall_at_10 * 100).toFixed(1)}%\n`);
  process.stderr.write(`[cat26]   model_call_ids=${modelCallIds.length}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const corpus = loadCorpus();
  const pages = corpus.pages;
  const queries = loadQueries();
  const pack = loadEvalPack();

  if (args.validate) {
    const stats = await validateFixedInputs(pack, pages, corpus.pageRefs, queries, args.benchrouter);
    process.stderr.write('[cat26] validate ok\n');
    process.stderr.write(`[cat26]   corpus pages: ${pages.length}\n`);
    process.stderr.write(`[cat26]   queries: ${queries.length}\n`);
    process.stderr.write(`[cat26]   total chunks: ${stats.totalChunks}\n`);
    process.stderr.write(`[cat26]   expected synopsis calls: ${stats.totalChunks}\n`);
    process.stderr.write(`[cat26]   eval-pack max_model_calls: ${pack.max_model_calls}\n`);
    process.stderr.write(`[cat26]   synopsis model: ${resolveSynopsisModel(args.benchrouter)}\n`);
    process.stderr.write(`[cat26]   eval-pack: ${EVAL_PACK_PATH}\n`);
    process.stderr.write(`[cat26]   primary_metric: ${pack.primary_metric}\n`);
    if (stats.totalChunks > pack.max_model_calls) {
      throw new Error(
        `fixture needs ${stats.totalChunks} synopsis calls but eval-pack max_model_calls is ${pack.max_model_calls}`,
      );
    }
    return;
  }

  const modes = args.benchrouter ? (['per_chunk_synopsis'] as Mode[]) : args.modes;
  process.stderr.write(
    `[cat26] testing ${pages.length} pages × ${queries.length} queries × ${modes.length} mode(s)...\n`,
  );

  const results: ModeResult[] = [];
  for (const mode of modes) {
    process.stderr.write(`[cat26]   mode=${mode}...\n`);
    const r = await runMode(mode, pages, queries, args.benchrouter);
    results.push(r);
    process.stderr.write(
      `[cat26]   mode=${mode} mean R@1=${(r.mean_recall_at_1 * 100).toFixed(1)}% ` +
      `R@5=${(r.mean_recall_at_5 * 100).toFixed(1)}% ` +
      `R@10=${(r.mean_recall_at_10 * 100).toFixed(1)}%\n`,
    );
  }

  if (args.benchrouter) {
    const synopsis = results.find(r => r.mode === 'per_chunk_synopsis');
    if (!synopsis) throw new Error('benchrouter mode requires per_chunk_synopsis result');
    if (modelCallIds.length === 0) {
      throw new Error('benchrouter mode produced no model_call_ids; synopsis calls did not pass through BenchRouter');
    }
    if (modelCallIds.length > pack.max_model_calls) {
      throw new Error(
        `synopsis model calls (${modelCallIds.length}) exceed eval-pack max_model_calls (${pack.max_model_calls})`,
      );
    }
    const resultPath = args.resultPath ?? pack.result_path;
    writeBenchRouterResult(resultPath, synopsis, queries);
    return;
  }

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const bestMode = results.reduce((a, b) =>
    a.mean_recall_at_10 >= b.mean_recall_at_10 ? a : b,
  ).mode;
  const noneR = results.find(r => r.mode === 'none');
  const titleR = results.find(r => r.mode === 'title');
  const synR = results.find(r => r.mode === 'per_chunk_synopsis');

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat26-contextual-retrieval',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    corpus_pages: pages.length,
    queries: queries.length,
    modes: results,
    best_mode: bestMode,
    none_vs_title_delta_at_5: (titleR?.mean_recall_at_5 ?? 0) - (noneR?.mean_recall_at_5 ?? 0),
    none_vs_synopsis_delta_at_5: (synR?.mean_recall_at_5 ?? 0) - (noneR?.mean_recall_at_5 ?? 0),
    none_vs_title_delta_at_10: (titleR?.mean_recall_at_10 ?? 0) - (noneR?.mean_recall_at_10 ?? 0),
    none_vs_synopsis_delta_at_10: (synR?.mean_recall_at_10 ?? 0) - (noneR?.mean_recall_at_10 ?? 0),
  };

  const outDir = join(process.cwd(), 'eval/reports/cat26-contextual-retrieval');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat26.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write('\n[cat26] ─── Scorecard ───────────────────\n');
  for (const r of results) {
    process.stderr.write(
      `[cat26]   mode=${r.mode.padEnd(22)} ` +
      `R@1=${(r.mean_recall_at_1 * 100).toFixed(1)}% ` +
      `R@5=${(r.mean_recall_at_5 * 100).toFixed(1)}% ` +
      `R@10=${(r.mean_recall_at_10 * 100).toFixed(1)}%\n`,
    );
  }
  process.stderr.write(`[cat26]   best mode:           ${bestMode}\n`);
  process.stderr.write(`[cat26]   receipt:             ${outFile}\n`);
}

await main();
