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
 *   3. Grounded queries with gold slugs across people, companies, and meetings.
 *   4. For each (mode, query) measure MRR and Recall@1, Recall@5, and Recall@10.
 *   5. Report mode-vs-mode deltas.
 *
 * BenchRouter repository_executable mode (`--benchrouter` or
 * BENCHROUTER_EXEC_RESULT_PATH) runs a fixed title baseline and the routed
 * synopsis candidate:
 *   - Synopsis uses gbrain native Anthropic Messages via ANTHROPIC_BASE_URL
 *   - Outbound model is `anthropic:<route-id>` (the server binds the candidate)
 *   - ANTHROPIC_API_KEY is the server-issued ephemeral eval token from the kit
 *   - Embeddings stay on google:gemini-embedding-001 at 1,536 dimensions
 *   - No fetch wrapper, client-forged headers, or echoed model-call IDs
 *   - Synopsis page_fallback fails the eval
 *   - Writes benchrouter.executable_result.v1 to result_path
 *
 * Run:
 *   bun eval/runner/cat26-contextual-retrieval.ts
 *   bun eval/runner/cat26-contextual-retrieval.ts --benchrouter
 *   bun eval/runner/cat26-contextual-retrieval.ts --validate
 */

import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
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
const PRIMARY_METRIC = 'mrr';

const MIN_PAGES = 12;
const MIN_QUERIES = 24;
const MIN_TOTAL_CHUNKS = 15;
const MIN_CONTEXTUAL_GOLD_PAGES = 12;
const MIN_MULTICHUNK_GOLD_PAGES = 4;

interface CorpusPage {
  slug: string;
  title: string;
  body: string;
  type: 'person' | 'company' | 'meeting';
}

interface CorpusFile {
  schema_version: number;
  source: 'world-v1';
  page_refs: string[];
}

interface WorldPage {
  slug: string;
  title: string;
  type: 'person' | 'company' | 'meeting';
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
  per_query_mrr: number[];
  mean_recall_at_1: number;
  mean_recall_at_5: number;
  mean_recall_at_10: number;
  mean_mrr: number;
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
  title_vs_none_delta_mrr: number;
  synopsis_vs_title_delta_mrr: number;
  none_vs_title_delta_at_5: number;
  none_vs_synopsis_delta_at_5: number;
  none_vs_title_delta_at_10: number;
  none_vs_synopsis_delta_at_10: number;
}

interface BenchRouterExecutableResult {
  schema_version: 'benchrouter.executable_result.v1';
  primary_metric: { name: string; score: number };
  metrics: Record<string, number>;
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
    '  --benchrouter    BenchRouter repository_executable mode (title baseline + synopsis candidate)\n' +
    '  --result-path    Override benchrouter.executable_result.v1 output path\n' +
    '  --modes          Comma-separated modes (default: none,title,per_chunk_synopsis)\n',
  );
}

function validateModeList(modes: Mode[]): void {
  const allowed = new Set<Mode>(['none', 'title', 'per_chunk_synopsis']);
  if (modes.length === 0) throw new Error('--modes must include at least one mode');
  if (new Set(modes).size !== modes.length) throw new Error('--modes must not contain duplicates');
  for (const mode of modes) {
    if (!allowed.has(mode)) throw new Error(`unknown contextual retrieval mode: ${mode}`);
  }
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
    if (page.type !== 'person' && page.type !== 'company' && page.type !== 'meeting') {
      throw new Error(`${ref}: expected a person, company, or meeting fixture (got ${String(page.type)})`);
    }
    const timeline = page.timeline?.trim();
    return {
      slug: page.slug,
      title: page.title,
      type: page.type,
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

let benchRouterRoutingInstalled = false;

/**
 * Configure native Anthropic routing for the repository executable. The kit
 * exposes the server-issued model-call token as an environment value. The
 * token is used as the normal SDK API key, so the server owns route and call
 * attribution without a client-side fetch or response-header shim.
 */
function installBenchRouterSynopsisRouting(): void {
  if (benchRouterRoutingInstalled) return;

  const evalBaseRaw = process.env.BENCHROUTER_EVAL_BASE_URL?.trim();
  if (!evalBaseRaw) {
    throw new Error('BENCHROUTER_EVAL_BASE_URL is required in --benchrouter mode');
  }
  const evalBaseUrl = normalizeAnthropicBaseUrl(evalBaseRaw);
  process.env.ANTHROPIC_BASE_URL = evalBaseUrl;
  const evalToken = process.env.BENCHROUTER_API_KEY?.trim();
  if (!evalToken || !evalToken.startsWith('ecall_')) {
    throw new Error(
      'BenchRouter mode requires the server-issued ecall_ token in BENCHROUTER_API_KEY',
    );
  }
  process.env.ANTHROPIC_API_KEY = evalToken;
  benchRouterRoutingInstalled = true;
}

/**
 * Outbound synopsis model for BenchRouter: Anthropic transport + route id body.
 * Candidate identity is bound by the server-issued eval token.
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

async function importFixturePages(
  engine: PGLiteEngine,
  pages: CorpusPage[],
  opts: { noEmbed: boolean },
): Promise<FixtureStats> {
  const perPageChunks: Record<string, number> = {};
  let totalChunks = 0;
  for (const page of pages) {
    const body = `# ${page.title}\n\n${page.body}\n`;
    const imported = await importFromContent(engine, page.slug, body, { noEmbed: opts.noEmbed });
    if (imported.status !== 'imported') {
      throw new Error(
        `fixture import failed for ${page.slug}: ${imported.status}${imported.error ? ` (${imported.error})` : ''}`,
      );
    }
    const storedPage = await engine.getPage(page.slug, { sourceId: 'default' });
    if (!storedPage) {
      throw new Error(`fixture import did not persist page ${page.slug}`);
    }
    const chunks = await engine.getChunks(page.slug, { sourceId: 'default' });
    if (chunks.length === 0) {
      throw new Error(`fixture import produced no chunks for ${page.slug}`);
    }
    perPageChunks[page.slug] = chunks.length;
    totalChunks += chunks.length;
  }
  return { totalChunks, perPageChunks };
}

async function measureFixtureChunks(pages: CorpusPage[]): Promise<FixtureStats> {
  const engine = new PGLiteEngine() as PGLiteEngine;
  try {
    await engine.connect({});
    await engine.initSchema();
    return await importFixturePages(engine, pages, { noEmbed: true });
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
  const goldTypes = new Set(
    pages.filter((page) => goldPages.has(page.slug)).map((page) => page.type),
  );
  for (const requiredType of ['person', 'company', 'meeting'] as const) {
    if (!goldTypes.has(requiredType)) {
      throw new Error(`queries must include a gold page of type ${requiredType}`);
    }
  }
  const multichunkGoldPages = [...goldPages].filter(
    (slug) => (stats.perPageChunks[slug] ?? 0) >= 2,
  );
  if (multichunkGoldPages.length < MIN_MULTICHUNK_GOLD_PAGES) {
    throw new Error(
      `contextual retrieval needs at least ${MIN_MULTICHUNK_GOLD_PAGES} multi-chunk gold pages ` +
      `(got ${multichunkGoldPages.length})`,
    );
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
}

/**
 * gbrain records synopsis failures in bounded JSONL audit events. Read only
 * the latest matching events so a transport failure remains diagnosable while
 * the evaluator keeps contract validity separate from retrieval quality.
 */
function readSynopsisAuditDetail(pageSlug: string): string {
  const auditDir = process.env.GBRAIN_AUDIT_DIR?.trim() || join(homedir(), '.gbrain', 'audit');
  let files: string[];
  try {
    files = readdirSync(auditDir)
      .filter((name) => name.startsWith('synopsis-failures-') && name.endsWith('.jsonl'))
      .sort()
      .slice(-2);
  } catch {
    return '';
  }
  const events: string[] = [];
  for (const file of files) {
    let lines: string[];
    try {
      lines = readFileSync(join(auditDir, file), 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          page_slug?: unknown;
          chunk_index?: unknown;
          kind?: unknown;
          detail?: unknown;
        };
        if (event.page_slug !== pageSlug) continue;
        const kind = typeof event.kind === 'string' ? event.kind : 'unknown';
        const chunk = Number.isInteger(event.chunk_index) ? `chunk=${event.chunk_index} ` : '';
        const detail = typeof event.detail === 'string' ? event.detail.slice(0, 200) : '';
        events.push(`${chunk}${kind}${detail ? `: ${detail}` : ''}`);
      } catch {
        // The audit file is best-effort diagnostic context.
      }
    }
  }
  return events.slice(-3).join(' | ');
}

function synopsisFailureDetail(pageSlug: string, kind: string, detail?: string): string {
  const audit = readSynopsisAuditDetail(pageSlug);
  const direct = detail ? ` detail=${detail.slice(0, 200)}` : '';
  const auditText = audit ? ` audit=${audit}` : '';
  const transportEvidence = `${detail ?? ''} ${audit}`;
  const label = kind === 'malformed' &&
      /fetch|network|transport|socket|econn|timeout|connection|502|503|504/i.test(transportEvidence)
    ? 'unknown_transport'
    : kind;
  const classification = label === kind ? '' : ` gbrain_classification=${kind}`;
  return `gbrain_failure_class=${label}${classification}${direct}${auditText}`;
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

async function applyContextualReembed(
  engine: PGLiteEngine,
  pages: CorpusPage[],
  mode: Mode,
  synopsisModel: string,
  benchrouter: boolean,
): Promise<void> {
  for (const page of pages) {
    const result = await reembedPageWithContextualRetrieval({
      engine,
      pageSlug: page.slug,
      sourceId: 'default',
      globalMode: mode,
      ...(mode === 'per_chunk_synopsis' ? { synopsisModel } : {}),
    });
    if (result.kind === 'transient_error' || result.kind === 'permanent_error') {
      throw new Error(
        `synopsis re-embed contract/transport failure for ${page.slug}: ` +
        synopsisFailureDetail(page.slug, result.cause, result.detail),
      );
    }
    if (result.kind === 'page_fallback') {
      throw new Error(
        `synopsis re-embed contract/transport fallback for ${page.slug}: ` +
        `${result.mode_attempted} -> ${result.mode_applied} ` +
        `(${synopsisFailureDetail(page.slug, result.fallback_kind)})`,
      );
    }
    if (benchrouter && result.kind !== 'success') {
      throw new Error(`unexpected synopsis result for ${page.slug}: ${result.kind}`);
    }
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function reciprocalRank(docs: RankedDoc[], relevant: Set<string>): number {
  const rank = docs.findIndex((doc) => relevant.has(doc.page_id));
  return rank < 0 ? 0 : 1 / (rank + 1);
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
    await importFixturePages(engine, pages, { noEmbed: mode !== 'none' });
    if (mode !== 'none') {
      await applyContextualReembed(
        engine,
        pages,
        mode,
        resolveSynopsisModel(benchrouter),
        benchrouter,
      );
    }

    const perQ1: number[] = [];
    const perQ5: number[] = [];
    const perQ10: number[] = [];
    const perQmrr: number[] = [];
    for (const q of queries) {
      const results = await hybridSearch(engine, q.query, { limit: 30 } as any);
      const docs = toRankedDocs(results as Array<{ slug: string; score?: number }>).slice(0, 10);
      const rel = new Set(q.relevant_slugs);
      perQ1.push(recallAtK(docs, rel, 1));
      perQ5.push(recallAtK(docs, rel, 5));
      perQ10.push(recallAtK(docs, rel, 10));
      perQmrr.push(reciprocalRank(docs, rel));
    }

    return {
      mode,
      per_query_recall_at_1: perQ1,
      per_query_recall_at_5: perQ5,
      per_query_recall_at_10: perQ10,
      per_query_mrr: perQmrr,
      mean_recall_at_1: mean(perQ1),
      mean_recall_at_5: mean(perQ5),
      mean_recall_at_10: mean(perQ10),
      mean_mrr: mean(perQmrr),
    };
  } finally {
    console.log = origLog;
    await engine.disconnect();
  }
}

function writeBenchRouterResult(
  resultPath: string,
  baseline: ModeResult,
  synopsis: ModeResult,
  queries: QuerySpec[],
): void {
  const mrrLift = synopsis.mean_mrr - baseline.mean_mrr;
  mkdirSync(join(process.cwd(), '.benchrouter'), { recursive: true });
  const observations = queries.map((q, idx) => ({
    id: q.id,
    version: '1',
    critical: false,
    pass: (synopsis.per_query_mrr[idx] ?? 0) > 0,
    score: synopsis.per_query_mrr[idx] ?? 0,
  }));
  const payload: BenchRouterExecutableResult = {
    schema_version: 'benchrouter.executable_result.v1',
    primary_metric: {
      name: PRIMARY_METRIC,
      score: synopsis.mean_mrr,
    },
    metrics: {
      candidate_mrr: synopsis.mean_mrr,
      baseline_mrr: baseline.mean_mrr,
      candidate_recall_at_1: synopsis.mean_recall_at_1,
      candidate_recall_at_5: synopsis.mean_recall_at_5,
      candidate_recall_at_10: synopsis.mean_recall_at_10,
      baseline_recall_at_1: baseline.mean_recall_at_1,
      baseline_recall_at_5: baseline.mean_recall_at_5,
      baseline_recall_at_10: baseline.mean_recall_at_10,
    },
    observations,
  };
  writeFileSync(resultPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  process.stderr.write(`[cat26] benchrouter result: ${resultPath}\n`);
  process.stderr.write(`[cat26]   candidate_mrr=${(synopsis.mean_mrr * 100).toFixed(1)}%\n`);
  process.stderr.write(`[cat26]   baseline_mrr=${(baseline.mean_mrr * 100).toFixed(1)}%\n`);
  process.stderr.write(`[cat26]   signed_mrr_lift=${(mrrLift * 100).toFixed(1)} points\n`);
  process.stderr.write(`[cat26]   candidate_recall_at_5=${(synopsis.mean_recall_at_5 * 100).toFixed(1)}%\n`);
  process.stderr.write(`[cat26]   candidate_recall_at_10=${(synopsis.mean_recall_at_10 * 100).toFixed(1)}%\n`);
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
  validateModeList(args.modes);

  if (args.validate) {
    const stats = await validateFixedInputs(pack, pages, corpus.pageRefs, queries, args.benchrouter);
    process.stderr.write('[cat26] validate ok\n');
    process.stderr.write(`[cat26]   corpus pages: ${pages.length}\n`);
    process.stderr.write(`[cat26]   queries: ${queries.length}\n`);
    process.stderr.write(`[cat26]   total chunks: ${stats.totalChunks}\n`);
    process.stderr.write(`[cat26]   modes: ${args.modes.join(',')}\n`);
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

  const fixtureStats = await measureFixtureChunks(pages);
  validateQueries(queries, pages);
  validateFixtureInvariants(pages, queries, fixtureStats);
  if (fixtureStats.totalChunks > pack.max_model_calls) {
    throw new Error(
      `fixture needs ${fixtureStats.totalChunks} synopsis calls but eval-pack max_model_calls is ${pack.max_model_calls}`,
    );
  }

  const modes = args.benchrouter
    ? (['title', 'per_chunk_synopsis'] as Mode[])
    : args.modes;
  process.stderr.write(
    `[cat26] testing ${pages.length} pages × ${queries.length} queries × ${modes.length} mode(s)...\n`,
  );

  const results: ModeResult[] = [];
  for (const mode of modes) {
    process.stderr.write(`[cat26]   mode=${mode}...\n`);
    const r = await runMode(mode, pages, queries, args.benchrouter && mode === 'per_chunk_synopsis');
    results.push(r);
    process.stderr.write(
      `[cat26]   mode=${mode} mean MRR=${(r.mean_mrr * 100).toFixed(1)}% ` +
      `R@1=${(r.mean_recall_at_1 * 100).toFixed(1)}% ` +
      `R@5=${(r.mean_recall_at_5 * 100).toFixed(1)}% ` +
      `R@10=${(r.mean_recall_at_10 * 100).toFixed(1)}%\n`,
    );
  }

  if (args.benchrouter) {
    const baseline = results.find(r => r.mode === 'title');
    const synopsis = results.find(r => r.mode === 'per_chunk_synopsis');
    if (!baseline) throw new Error('benchrouter mode requires title baseline result');
    if (!synopsis) throw new Error('benchrouter mode requires per_chunk_synopsis result');
    const resultPath = args.resultPath ?? pack.result_path;
    writeBenchRouterResult(resultPath, baseline, synopsis, queries);
    return;
  }

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const bestMode = results.reduce((a, b) =>
    a.mean_mrr >= b.mean_mrr ? a : b,
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
    title_vs_none_delta_mrr: (titleR?.mean_mrr ?? 0) - (noneR?.mean_mrr ?? 0),
    synopsis_vs_title_delta_mrr: (synR?.mean_mrr ?? 0) - (titleR?.mean_mrr ?? 0),
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
      `MRR=${(r.mean_mrr * 100).toFixed(1)}% ` +
      `R@1=${(r.mean_recall_at_1 * 100).toFixed(1)}% ` +
      `R@5=${(r.mean_recall_at_5 * 100).toFixed(1)}% ` +
      `R@10=${(r.mean_recall_at_10 * 100).toFixed(1)}%\n`,
    );
  }
  process.stderr.write(`[cat26]   best mode:           ${bestMode}\n`);
  process.stderr.write(`[cat26]   receipt:             ${outFile}\n`);
}

await main();
