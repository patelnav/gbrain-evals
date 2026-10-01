/**
 * Contextual-synopsis retrieval eval (BenchRouter route
 * `gbrain-evals/contextual-synopsis`).
 *
 * Headline question: when gbrain writes a one-sentence synopsis for every
 * chunk before embedding it (`per_chunk_synopsis`), how much of the required
 * evidence lands in the top five search results, and which synopsis model
 * gives that recall at the lowest cost?
 *
 * Corpora:
 *   - amara-life-v1 (default, and the only BenchRouter corpus): all 424 items
 *     of the fictional VC inbox in eval/data/amara-life-v1, one gbrain page
 *     per manifest item. 93 hand-written questions with complete gold labels
 *     live in eval/data/contextual-synopsis-amara-life/queries.json.
 *   - cat26 (`--corpus cat26`): the earlier 15-page world-v1 fixture, kept so
 *     the MRR results recorded against it stay reproducible.
 *
 * Flow:
 *   1. Import the corpus into a fresh in-memory PGLite brain.
 *   2. Re-embed every page in each requested mode: none, title,
 *      per_chunk_synopsis.
 *   3. Run each question through gbrain hybrid search with reranking, query
 *      expansion, and the search cache pinned off.
 *   4. Score Recall@1/5/10, strict Recall-all@5, and MRR per question.
 *
 * BenchRouter repository_executable mode (`--benchrouter` or
 * BENCHROUTER_EXEC_RESULT_PATH) runs a fixed title baseline and the routed
 * synopsis candidate on amara-life-v1:
 *   - Synopsis uses gbrain native Anthropic Messages via ANTHROPIC_BASE_URL
 *   - Outbound model is `anthropic:<route-id>` (the server binds the candidate)
 *   - ANTHROPIC_API_KEY is the server-issued ephemeral eval token from the kit
 *   - Embeddings stay on google:gemini-embedding-001 at 1,536 dimensions
 *   - No fetch wrapper, client-forged headers, or echoed model-call IDs
 *   - Synopsis page_fallback fails the eval
 *   - Writes benchrouter.executable_result.v1 to result_path with the
 *     candidate's Recall@5 as the primary metric
 *
 * Run:
 *   bun eval/runner/benchrouter-contextual-synopsis.ts --validate
 *   bun eval/runner/benchrouter-contextual-synopsis.ts --modes none,title
 *   bun eval/runner/benchrouter-contextual-synopsis.ts --benchrouter
 *   bun eval/runner/benchrouter-contextual-synopsis.ts --corpus cat26
 */

import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import { reembedPageWithContextualRetrieval } from '../../node_modules/gbrain/src/core/contextual-retrieval-service.ts';
import { loadSearchModeConfig, resolveSearchMode } from '../../node_modules/gbrain/src/core/search/mode.ts';
import { recallAtK, type RankedDoc } from './types.ts';
import { recallAllAtK } from './metrics.ts';
import { AMARA_LIFE_MANIFEST, amaraLifeSourceFiles, loadAmaraLifePages } from './amara-life-pages.ts';

const CAT26_CORPUS_PATH = 'eval/data/cat26-contextual-retrieval/corpus.json';
const CAT26_QUERIES_PATH = 'eval/data/cat26-contextual-retrieval/queries.json';
const AMARA_QUERIES_PATH = 'eval/data/contextual-synopsis-amara-life/queries.json';
const AMARA_PAGES_MODULE = 'eval/runner/amara-life-pages.ts';
const EVAL_PACK_PATH = '.benchrouter/contextual-synopsis-eval-pack.json';
const ROUTE_ID = 'gbrain-evals/contextual-synopsis';
const INCUMBENT_SYNOPSIS_MODEL = 'anthropic:claude-haiku-4-5-20251001';
const EMBEDDING_MODEL = 'google:gemini-embedding-001';
const EMBEDDING_DIM = 1536;
const PRIMARY_METRIC = 'recall_at_5';

type CorpusId = 'amara-life-v1' | 'cat26';

interface FixtureLimits {
  minPages: number;
  minQueries: number;
  minTotalChunks: number;
  minGoldPages: number;
  /** Page types that must each supply at least one gold page. */
  requiredGoldTypes: string[];
  /**
   * cat26 was built to exercise cross-chunk context. Every amara-life-v1 item
   * fits in one chunk, so there the synopsis situates a whole page instead.
   */
  minMultichunkGoldPages: number;
}

const LIMITS: Record<CorpusId, FixtureLimits> = {
  'amara-life-v1': {
    minPages: 424,
    minQueries: 80,
    minTotalChunks: 424,
    minGoldPages: 100,
    requiredGoldTypes: ['email', 'slack', 'calendar-event', 'note', 'meeting', 'source'],
    minMultichunkGoldPages: 0,
  },
  cat26: {
    minPages: 12,
    minQueries: 24,
    minTotalChunks: 15,
    minGoldPages: 12,
    requiredGoldTypes: ['person', 'company', 'meeting'],
    minMultichunkGoldPages: 4,
  },
};

interface CorpusPage {
  slug: string;
  /** Markdown handed to importFromContent. */
  content: string;
  type: string;
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

interface LoadedFixture {
  corpus: CorpusId;
  pages: CorpusPage[];
  /** Committed files the pages were built from; each must be an eval-pack input_ref. */
  sourceRefs: string[];
  queriesPath: string;
  queries: QuerySpec[];
}

interface QuerySpec {
  id: string;
  query: string;
  relevant_slugs: string[];
  /** amara-life-v1 only: single_fact or conflicting_sources. */
  kind?: string;
  /**
   * amara-life-v1 only: case-insensitive substrings. The pages containing all
   * of them must equal relevant_slugs, which checks label completeness.
   */
  evidence?: string[];
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

interface QueryResult {
  id: string;
  kind?: string;
  relevant_slugs: string[];
  top_10: string[];
  recall_at_1: number;
  recall_at_5: number;
  recall_at_10: number;
  recall_all_at_5: number;
  mrr: number;
}

interface ModeResult {
  mode: Mode;
  per_query: QueryResult[];
  mean_recall_at_1: number;
  mean_recall_at_5: number;
  mean_recall_at_10: number;
  mean_recall_all_at_5: number;
  mean_mrr: number;
  /** Mean Recall@5 over the questions of each kind (amara-life-v1). */
  recall_at_5_by_kind: Record<string, number>;
}

interface Receipt {
  schema_version: 2;
  cat: 'contextual-synopsis';
  corpus: CorpusId;
  gbrain_version: string;
  timestamp: string;
  corpus_pages: number;
  queries: number;
  embedding_model: string;
  embedding_dimensions: number;
  synopsis_model: string;
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
}

interface ParsedArgs {
  help: boolean;
  validate: boolean;
  benchrouter: boolean;
  corpus: CorpusId;
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
    corpus: 'amara-life-v1',
    modes: ['none', 'title', 'per_chunk_synopsis'],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--validate') out.validate = true;
    else if (arg === '--benchrouter') out.benchrouter = true;
    else if (arg === '--corpus') out.corpus = argv[++i] as CorpusId;
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
    'contextual-synopsis — fixed-corpus contextual retrieval benchmark\n\n' +
    'Usage:\n' +
    '  bun eval/runner/benchrouter-contextual-synopsis.ts [--validate] [--corpus amara-life-v1|cat26]\n' +
    '  bun eval/runner/benchrouter-contextual-synopsis.ts --benchrouter [--result-path PATH]\n' +
    '  bun eval/runner/benchrouter-contextual-synopsis.ts --modes none,title\n\n' +
    'Flags:\n' +
    '  --validate       Check corpus, queries, labels, eval-pack, and chunk invariants (no network)\n' +
    '  --benchrouter    BenchRouter repository_executable mode on amara-life-v1\n' +
    '                   (title baseline + synopsis candidate)\n' +
    '  --corpus         amara-life-v1 (default) or cat26 (earlier 15-page fixture)\n' +
    '  --result-path    Override benchrouter.executable_result.v1 output path\n' +
    '  --modes          Comma-separated modes (default: none,title,per_chunk_synopsis)\n',
  );
}

function validateCorpusArg(args: ParsedArgs): void {
  if (args.corpus !== 'amara-life-v1' && args.corpus !== 'cat26') {
    throw new Error(`unknown --corpus ${String(args.corpus)} (expected amara-life-v1 or cat26)`);
  }
  if (args.benchrouter && args.corpus !== 'amara-life-v1') {
    throw new Error('--benchrouter runs the eval-pack corpus, amara-life-v1; drop --corpus cat26');
  }
}

function validateModeList(modes: Mode[]): void {
  const allowed = new Set<Mode>(['none', 'title', 'per_chunk_synopsis']);
  if (modes.length === 0) throw new Error('--modes must include at least one mode');
  if (new Set(modes).size !== modes.length) throw new Error('--modes must not contain duplicates');
  for (const mode of modes) {
    if (!allowed.has(mode)) throw new Error(`unknown contextual retrieval mode: ${mode}`);
  }
}

function loadCat26Pages(): { pages: CorpusPage[]; pageRefs: string[] } {
  const raw = JSON.parse(readFileSync(CAT26_CORPUS_PATH, 'utf8')) as CorpusFile;
  if (raw.source !== 'world-v1' || !Array.isArray(raw.page_refs) || raw.page_refs.length === 0) {
    throw new Error(`${CAT26_CORPUS_PATH}: expected a non-empty world-v1 page_refs array`);
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
    const body = timeline
      ? `${page.compiled_truth}\n\n## Timeline\n\n${timeline}`
      : page.compiled_truth;
    return {
      slug: page.slug,
      type: page.type,
      content: `# ${page.title}\n\n${body}\n`,
    };
  });
  return { pages, pageRefs: raw.page_refs };
}

function loadQueries(path: string): QuerySpec[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as QueriesFile;
  if (!Array.isArray(raw.queries) || raw.queries.length === 0) {
    throw new Error(`${path}: missing queries array`);
  }
  return raw.queries;
}

export function loadFixture(corpus: CorpusId): LoadedFixture {
  if (corpus === 'cat26') {
    const { pages, pageRefs } = loadCat26Pages();
    return {
      corpus,
      pages,
      sourceRefs: [CAT26_CORPUS_PATH, ...pageRefs],
      queriesPath: CAT26_QUERIES_PATH,
      queries: loadQueries(CAT26_QUERIES_PATH),
    };
  }
  const amaraPages = loadAmaraLifePages();
  return {
    corpus,
    pages: amaraPages.map(p => ({ slug: p.slug, type: p.type, content: p.content })),
    sourceRefs: [AMARA_PAGES_MODULE, AMARA_LIFE_MANIFEST, ...amaraLifeSourceFiles(amaraPages)],
    queriesPath: AMARA_QUERIES_PATH,
    queries: loadQueries(AMARA_QUERIES_PATH),
  };
}

export function loadEvalPack(): EvalPack {
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
export function installBenchRouterSynopsisRouting(): void {
  if (benchRouterRoutingInstalled) return;

  const evalBaseRaw = process.env.BENCHROUTER_EVAL_BASE_URL?.trim();
  if (!evalBaseRaw) {
    throw new Error('BENCHROUTER_EVAL_BASE_URL is required in --benchrouter mode');
  }
  const evalBaseUrl = normalizeAnthropicBaseUrl(evalBaseRaw);
  process.env.ANTHROPIC_BASE_URL = evalBaseUrl;
  const evalToken = process.env.BENCHROUTER_API_KEY?.trim();
  // RUN-001 / AUTH-010: the runtime injects an opaque item call token.
  // The server validates its authority; the evaluator only requires presence.
  if (!evalToken) {
    throw new Error(
      'BenchRouter mode requires the runtime-issued call token in BENCHROUTER_API_KEY',
    );
  }
  process.env.ANTHROPIC_API_KEY = evalToken;
  benchRouterRoutingInstalled = true;
}

/**
 * Outbound synopsis model for BenchRouter: Anthropic transport + route id body.
 * Candidate identity is bound by the server-issued eval token.
 */
export function resolveSynopsisModel(benchrouter: boolean): string {
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
    const imported = await importFromContent(engine, page.slug, page.content, { noEmbed: opts.noEmbed });
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

function validateQueries(fixture: LoadedFixture): void {
  const { queries, pages } = fixture;
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
    if (fixture.corpus === 'amara-life-v1') validateEvidenceLabels(q, pages);
  }
}

/**
 * Label completeness for amara-life-v1: the pages containing every evidence
 * substring must be exactly the labelled pages. An unlabelled page that
 * states the same fact, or a label on a page that does not, fails the check.
 */
function validateEvidenceLabels(q: QuerySpec, pages: CorpusPage[]): void {
  if (q.kind !== 'single_fact' && q.kind !== 'conflicting_sources') {
    throw new Error(`query ${q.id} kind must be single_fact or conflicting_sources`);
  }
  if (!Array.isArray(q.evidence) || q.evidence.length === 0 || q.evidence.some(e => !e.trim())) {
    throw new Error(`query ${q.id} requires non-empty evidence substrings`);
  }
  const needles = q.evidence.map(e => e.toLowerCase());
  const matching = pages
    .filter(page => {
      const text = page.content.toLowerCase();
      return needles.every(needle => text.includes(needle));
    })
    .map(page => page.slug);
  const gold = new Set(q.relevant_slugs);
  const unlabelled = matching.filter(slug => !gold.has(slug));
  const unsupported = q.relevant_slugs.filter(slug => !matching.includes(slug));
  if (unlabelled.length > 0 || unsupported.length > 0) {
    throw new Error(
      `query ${q.id} labels disagree with its evidence: ` +
      `unlabelled matches [${unlabelled.join(', ')}], labels without evidence [${unsupported.join(', ')}]`,
    );
  }
}

function validateFixtureInvariants(fixture: LoadedFixture, stats: FixtureStats): void {
  const { pages, queries } = fixture;
  const limits = LIMITS[fixture.corpus];
  if (pages.length < limits.minPages) {
    throw new Error(`corpus must have at least ${limits.minPages} pages (got ${pages.length})`);
  }
  if (queries.length < limits.minQueries) {
    throw new Error(`queries must have at least ${limits.minQueries} entries (got ${queries.length})`);
  }
  if (stats.totalChunks < limits.minTotalChunks) {
    throw new Error(`corpus must produce at least ${limits.minTotalChunks} chunks (got ${stats.totalChunks})`);
  }
  if (pages.length <= 10) {
    throw new Error(`Recall@10 needs more than ten competing pages (got ${pages.length})`);
  }
  const goldPages = new Set(queries.flatMap(query => query.relevant_slugs));
  if (goldPages.size < limits.minGoldPages) {
    throw new Error(
      `contextual retrieval needs at least ${limits.minGoldPages} unique gold pages (got ${goldPages.size})`,
    );
  }
  const goldTypes = new Set(
    pages.filter((page) => goldPages.has(page.slug)).map((page) => page.type),
  );
  for (const requiredType of limits.requiredGoldTypes) {
    if (!goldTypes.has(requiredType)) {
      throw new Error(`queries must include a gold page of type ${requiredType}`);
    }
  }
  const multichunkGoldPages = [...goldPages].filter(
    (slug) => (stats.perPageChunks[slug] ?? 0) >= 2,
  );
  if (multichunkGoldPages.length < limits.minMultichunkGoldPages) {
    throw new Error(
      `contextual retrieval needs at least ${limits.minMultichunkGoldPages} multi-chunk gold pages ` +
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

/**
 * Everything --validate checks except chunk measurement, which needs a
 * PGLite import of the whole corpus.
 */
export function validateStaticInputs(
  pack: EvalPack,
  fixture: LoadedFixture,
  benchrouter: boolean,
): void {
  for (const ref of pack.input_refs) readFileSync(ref, 'utf8');
  for (const ref of pack.acceptance_refs) readFileSync(ref, 'utf8');
  if (pack.case_refs) {
    for (const ref of pack.case_refs) readFileSync(ref, 'utf8');
  }
  validateEvalPackContract(pack);
  // The eval pack declares amara-life-v1; cat26 is a local-only corpus.
  if (fixture.corpus === 'amara-life-v1') {
    for (const ref of fixture.sourceRefs) {
      if (!pack.input_refs.includes(ref)) {
        throw new Error(`eval-pack input_refs must include corpus source ${ref}`);
      }
    }
    if (!pack.acceptance_refs.includes(fixture.queriesPath)) {
      throw new Error(`eval-pack acceptance_refs must include ${fixture.queriesPath}`);
    }
  }
  validateQueries(fixture);
  validateSynopsisModelRouting(benchrouter);
}

/** Chunk measurement plus the invariants and call budget that depend on it. */
export async function validateChunkBudget(pack: EvalPack, fixture: LoadedFixture): Promise<FixtureStats> {
  const stats = await measureFixtureChunks(fixture.pages);
  validateFixtureInvariants(fixture, stats);
  if (stats.totalChunks > pack.max_model_calls) {
    throw new Error(
      `fixture needs ${stats.totalChunks} synopsis calls but eval-pack max_model_calls is ${pack.max_model_calls}`,
    );
  }
  return stats;
}

async function validateFixedInputs(
  pack: EvalPack,
  fixture: LoadedFixture,
  benchrouter: boolean,
): Promise<FixtureStats> {
  validateStaticInputs(pack, fixture, benchrouter);
  return validateChunkBudget(pack, fixture);
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

    // Pin every retrieval behavior outside the contextual wrapper under test.
    // Current gbrain defaults enable a hosted reranker in balanced mode when
    // its provider key is present. The eval must not silently change when the
    // runner's secret inventory changes.
    await engine.setConfig('search.mode', 'balanced');
    await engine.setConfig('search.reranker.enabled', 'false');
    await engine.setConfig('search.expansion', 'false');
    await engine.setConfig('search.cache.enabled', 'false');
    await engine.setConfig('search.contextual_retrieval', mode);

    const resolved = resolveSearchMode(await loadSearchModeConfig(engine));
    if (resolved.contextual_retrieval !== mode) {
      throw new Error(
        `requested contextual_retrieval=${mode} but gbrain resolved ${resolved.contextual_retrieval}`,
      );
    }
    if (resolved.reranker_enabled || resolved.expansion) {
      throw new Error(
        `retrieval pins were not applied: reranker=${resolved.reranker_enabled} expansion=${resolved.expansion}`,
      );
    }
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

    const perQuery: QueryResult[] = [];
    for (const q of queries) {
      const results = await hybridSearch(engine, q.query, { limit: 30 } as any);
      const docs = toRankedDocs(results as Array<{ slug: string; score?: number }>).slice(0, 10);
      const ids = docs.map(doc => doc.page_id);
      const rel = new Set(q.relevant_slugs);
      perQuery.push({
        id: q.id,
        ...(q.kind ? { kind: q.kind } : {}),
        relevant_slugs: q.relevant_slugs,
        top_10: ids,
        recall_at_1: recallAtK(docs, rel, 1),
        recall_at_5: recallAtK(docs, rel, 5),
        recall_at_10: recallAtK(docs, rel, 10),
        recall_all_at_5: recallAllAtK(ids, rel, 5),
        mrr: reciprocalRank(docs, rel),
      });
    }

    const byKind: Record<string, number> = {};
    for (const kind of new Set(perQuery.flatMap(r => (r.kind ? [r.kind] : [])))) {
      byKind[kind] = mean(perQuery.filter(r => r.kind === kind).map(r => r.recall_at_5));
    }
    return {
      mode,
      per_query: perQuery,
      mean_recall_at_1: mean(perQuery.map(r => r.recall_at_1)),
      mean_recall_at_5: mean(perQuery.map(r => r.recall_at_5)),
      mean_recall_at_10: mean(perQuery.map(r => r.recall_at_10)),
      mean_recall_all_at_5: mean(perQuery.map(r => r.recall_all_at_5)),
      mean_mrr: mean(perQuery.map(r => r.mrr)),
      recall_at_5_by_kind: byKind,
    };
  } finally {
    console.log = origLog;
    await engine.disconnect();
  }
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function writeBenchRouterResult(
  resultPath: string,
  baseline: ModeResult,
  synopsis: ModeResult,
): void {
  mkdirSync(dirname(resultPath), { recursive: true });
  const metrics: Record<string, number> = {
    candidate_recall_at_5: synopsis.mean_recall_at_5,
    candidate_recall_all_at_5: synopsis.mean_recall_all_at_5,
    candidate_recall_at_1: synopsis.mean_recall_at_1,
    candidate_recall_at_10: synopsis.mean_recall_at_10,
    candidate_mrr: synopsis.mean_mrr,
    baseline_recall_at_5: baseline.mean_recall_at_5,
    baseline_recall_all_at_5: baseline.mean_recall_all_at_5,
    baseline_recall_at_1: baseline.mean_recall_at_1,
    baseline_recall_at_10: baseline.mean_recall_at_10,
    baseline_mrr: baseline.mean_mrr,
  };
  for (const [kind, value] of Object.entries(synopsis.recall_at_5_by_kind)) {
    metrics[`candidate_recall_at_5_${kind}`] = value;
  }
  for (const [kind, value] of Object.entries(baseline.recall_at_5_by_kind)) {
    metrics[`baseline_recall_at_5_${kind}`] = value;
  }
  const payload: BenchRouterExecutableResult = {
    schema_version: 'benchrouter.executable_result.v1',
    primary_metric: {
      name: PRIMARY_METRIC,
      score: synopsis.mean_recall_at_5,
    },
    metrics,
  };
  writeFileSync(resultPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  const lift = synopsis.mean_recall_at_5 - baseline.mean_recall_at_5;
  process.stderr.write(`[contextual-synopsis] benchrouter result: ${resultPath}\n`);
  process.stderr.write(`[contextual-synopsis]   candidate_recall_at_5=${pct(synopsis.mean_recall_at_5)}\n`);
  process.stderr.write(`[contextual-synopsis]   baseline_recall_at_5=${pct(baseline.mean_recall_at_5)}\n`);
  process.stderr.write(`[contextual-synopsis]   signed_recall_at_5_lift=${(lift * 100).toFixed(1)} points\n`);
  process.stderr.write(`[contextual-synopsis]   candidate_recall_all_at_5=${pct(synopsis.mean_recall_all_at_5)}\n`);
  process.stderr.write(`[contextual-synopsis]   candidate_mrr=${pct(synopsis.mean_mrr)}\n`);
}

/**
 * Per-question lines for the CI log, so a BenchRouter run keeps which
 * questions each mode missed even though only the scalar result is uploaded.
 */
function logPerQuery(result: ModeResult): void {
  for (const r of result.per_query) {
    process.stderr.write(
      `[contextual-synopsis]   ${result.mode} ${r.id} R@5=${r.recall_at_5.toFixed(2)} ` +
      `top5=${r.top_10.slice(0, 5).join(',')}\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  validateCorpusArg(args);

  const fixture = loadFixture(args.corpus);
  const { pages, queries } = fixture;
  const pack = loadEvalPack();
  validateModeList(args.modes);
  const tag = `[contextual-synopsis:${fixture.corpus}]`;

  if (args.validate) {
    const stats = await validateFixedInputs(pack, fixture, args.benchrouter);
    const goldPages = new Set(queries.flatMap(q => q.relevant_slugs));
    process.stderr.write(`${tag} validate ok\n`);
    process.stderr.write(`${tag}   corpus pages: ${pages.length}\n`);
    process.stderr.write(`${tag}   queries: ${queries.length} (${goldPages.size} unique gold pages)\n`);
    process.stderr.write(`${tag}   total chunks: ${stats.totalChunks}\n`);
    process.stderr.write(`${tag}   modes: ${args.modes.join(',')}\n`);
    process.stderr.write(`${tag}   expected synopsis calls: ${stats.totalChunks}\n`);
    process.stderr.write(`${tag}   eval-pack max_model_calls: ${pack.max_model_calls}\n`);
    process.stderr.write(`${tag}   synopsis model: ${resolveSynopsisModel(args.benchrouter)}\n`);
    process.stderr.write(`${tag}   eval-pack: ${EVAL_PACK_PATH}\n`);
    process.stderr.write(`${tag}   primary_metric: ${pack.primary_metric}\n`);
    return;
  }

  const fixtureStats = await measureFixtureChunks(pages);
  validateQueries(fixture);
  validateFixtureInvariants(fixture, fixtureStats);
  if (fixtureStats.totalChunks > pack.max_model_calls) {
    throw new Error(
      `fixture needs ${fixtureStats.totalChunks} synopsis calls but eval-pack max_model_calls is ${pack.max_model_calls}`,
    );
  }

  const modes = args.benchrouter
    ? (['title', 'per_chunk_synopsis'] as Mode[])
    : args.modes;
  process.stderr.write(
    `${tag} testing ${pages.length} pages × ${queries.length} queries × ${modes.length} mode(s)...\n`,
  );

  const results: ModeResult[] = [];
  for (const mode of modes) {
    const started = Date.now();
    process.stderr.write(`${tag}   mode=${mode}...\n`);
    const r = await runMode(mode, pages, queries, args.benchrouter && mode === 'per_chunk_synopsis');
    results.push(r);
    process.stderr.write(
      `${tag}   mode=${mode} R@5=${pct(r.mean_recall_at_5)} ` +
      `R-all@5=${pct(r.mean_recall_all_at_5)} ` +
      `R@1=${pct(r.mean_recall_at_1)} ` +
      `R@10=${pct(r.mean_recall_at_10)} ` +
      `MRR=${pct(r.mean_mrr)} ` +
      `(${((Date.now() - started) / 1000).toFixed(0)}s)\n`,
    );
  }

  if (args.benchrouter) {
    const baseline = results.find(r => r.mode === 'title');
    const synopsis = results.find(r => r.mode === 'per_chunk_synopsis');
    if (!baseline) throw new Error('benchrouter mode requires title baseline result');
    if (!synopsis) throw new Error('benchrouter mode requires per_chunk_synopsis result');
    logPerQuery(baseline);
    logPerQuery(synopsis);
    const resultPath = args.resultPath ?? pack.result_path;
    writeBenchRouterResult(resultPath, baseline, synopsis);
    return;
  }

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const bestMode = results.reduce((a, b) =>
    a.mean_recall_at_5 >= b.mean_recall_at_5 ? a : b,
  ).mode;
  const noneR = results.find(r => r.mode === 'none');
  const titleR = results.find(r => r.mode === 'title');
  const synR = results.find(r => r.mode === 'per_chunk_synopsis');

  const receipt: Receipt = {
    schema_version: 2,
    cat: 'contextual-synopsis',
    corpus: fixture.corpus,
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    corpus_pages: pages.length,
    queries: queries.length,
    embedding_model: EMBEDDING_MODEL,
    embedding_dimensions: EMBEDDING_DIM,
    synopsis_model: resolveSynopsisModel(false),
    modes: results,
    best_mode: bestMode,
    title_vs_none_delta_mrr: (titleR?.mean_mrr ?? 0) - (noneR?.mean_mrr ?? 0),
    synopsis_vs_title_delta_mrr: (synR?.mean_mrr ?? 0) - (titleR?.mean_mrr ?? 0),
    none_vs_title_delta_at_5: (titleR?.mean_recall_at_5 ?? 0) - (noneR?.mean_recall_at_5 ?? 0),
    none_vs_synopsis_delta_at_5: (synR?.mean_recall_at_5 ?? 0) - (noneR?.mean_recall_at_5 ?? 0),
    none_vs_title_delta_at_10: (titleR?.mean_recall_at_10 ?? 0) - (noneR?.mean_recall_at_10 ?? 0),
    none_vs_synopsis_delta_at_10: (synR?.mean_recall_at_10 ?? 0) - (noneR?.mean_recall_at_10 ?? 0),
  };

  const outDir = join(process.cwd(), 'eval/reports/contextual-synopsis');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(
    outDir,
    `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${fixture.corpus}-${modes.join('+')}.json`,
  );
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n${tag} ─── Scorecard ───────────────────\n`);
  for (const r of results) {
    process.stderr.write(
      `${tag}   mode=${r.mode.padEnd(22)} ` +
      `R@5=${pct(r.mean_recall_at_5)} ` +
      `R-all@5=${pct(r.mean_recall_all_at_5)} ` +
      `R@1=${pct(r.mean_recall_at_1)} ` +
      `R@10=${pct(r.mean_recall_at_10)} ` +
      `MRR=${pct(r.mean_mrr)}` +
      Object.entries(r.recall_at_5_by_kind).map(([k, v]) => ` R@5[${k}]=${pct(v)}`).join('') +
      '\n',
    );
  }
  process.stderr.write(`${tag}   best mode (R@5):     ${bestMode}\n`);
  process.stderr.write(`${tag}   receipt:             ${outFile}\n`);
}

if (import.meta.main) await main();
