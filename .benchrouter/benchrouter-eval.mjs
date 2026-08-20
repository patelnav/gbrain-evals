import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

function parseManifestScalar(raw, label) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error(label + " has an invalid quoted value"); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  const unquoted = value.replace(/[ \t]+#.*$/, "").trim();
  if (unquoted === "null") return null;
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function requiredManifestString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw new Error(label + " is required without surrounding whitespace");
  return value;
}

function requiredManifestStringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(label + " must include at least one value");
  return value.map((entry, index) => requiredManifestString(entry, label + "[" + index + "]"));
}

function requiredManifestRepoPath(value, label) {
  const path = requiredManifestString(value, label);
  const parts = path.split("/");
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path) || parts.some((part) => !part || part === "." || part === "..")) throw new Error(label + " must be a normalized repository-relative path");
  return path;
}

function requiredManifestUniqueList(value, label, parser = requiredManifestString) {
  const parsed = requiredManifestStringList(value, label).map((entry, index) => parser(entry, label + "[" + index + "]"));
  if (new Set(parsed).size !== parsed.length) throw new Error(label + " must not contain duplicates");
  return parsed;
}

function requiredManifestPositiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(label + " must be a positive number");
  return value;
}

function requiredManifestPositiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(label + " must be a positive integer");
  return value;
}

function requiredExactRuntimeVersion(value, label) {
  const version = requiredManifestString(value, label);
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(label + " must be an exact runtime version");
  return version;
}

function parseBenchRouterManifest(yamlText, configPath) {
  const product = {};
  const routes = [];
  let area = "";
  let route = null;
  let section = "";
  let list = "";
  const lines = String(yamlText).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const label = configPath + ":" + (index + 1);
    if (line === "product:") { area = "product"; route = null; section = ""; list = ""; continue; }
    if (line === "routes:") { area = "routes"; route = null; section = ""; list = ""; continue; }
    let match;
    if (area === "product" && (match = line.match(/^  ([a-z_]+):\s*(.*)$/))) {
      product[match[1]] = parseManifestScalar(match[2], label);
      continue;
    }
    if (area === "routes" && (match = line.match(/^  - ([a-z_]+):\s*(.*)$/))) {
      route = { code_refs: [], metadata: {}, call_site: {}, seed: {}, eval_pack: {} };
      route[match[1]] = parseManifestScalar(match[2], label);
      routes.push(route);
      section = "";
      list = "";
      continue;
    }
    if (!route) continue;
    if ((match = line.match(/^    ([a-z_]+):\s*(.*)$/))) {
      const key = match[1];
      const raw = match[2];
      if (raw === "") {
        section = key;
        list = "";
        if (!route[key] || typeof route[key] !== "object") route[key] = {};
      } else if (key === "code_refs" && raw.trim() === "[]") {
        route.code_refs = [];
        section = "";
        list = "";
      } else {
        route[key] = parseManifestScalar(raw, label);
        section = "";
        list = "";
      }
      continue;
    }
    if (section === "code_refs" && (match = line.match(/^      -\s+(.*)$/))) {
      route.code_refs.push(parseManifestScalar(match[1], label));
      continue;
    }
    if ((match = line.match(/^      ([a-z_]+):\s*(.*)$/))) {
      const key = match[1];
      const raw = match[2];
      if (raw === "") {
        list = key;
        route[section][key] = [];
      } else {
        route[section][key] = parseManifestScalar(raw, label);
        list = "";
      }
      continue;
    }
    if (section && list && (match = line.match(/^        -\s+(.*)$/))) {
      route[section][list].push(parseManifestScalar(match[1], label));
    }
  }
  const normalizedRoutes = routes.map((entry, index) => {
    const prefix = configPath + ".routes[" + index + "]";
    const caseRefs = Array.isArray(entry.eval_pack.case_refs) ? requiredManifestUniqueList(entry.eval_pack.case_refs, prefix + ".eval_pack.case_refs", requiredManifestRepoPath) : [];
    if (caseRefs.length === 0) throw new Error(prefix + ".eval_pack.case_refs must include at least one path");
    const mode = entry.eval_pack.mode === "repository_executable" ? "repository_executable" : "isolated_replay";
    const executable = mode === "repository_executable" ? {
      argv: requiredManifestStringList(entry.eval_pack.argv, prefix + ".eval_pack.argv"),
      runtime: requiredManifestString(entry.eval_pack.runtime, prefix + ".eval_pack.runtime"),
      runtimeVersion: requiredExactRuntimeVersion(entry.eval_pack.runtime_version, prefix + ".eval_pack.runtime_version"),
      lockfile: requiredManifestRepoPath(entry.eval_pack.lockfile, prefix + ".eval_pack.lockfile"),
      inputRefs: requiredManifestUniqueList(entry.eval_pack.input_refs, prefix + ".eval_pack.input_refs", requiredManifestRepoPath),
      acceptanceRefs: requiredManifestUniqueList(entry.eval_pack.acceptance_refs, prefix + ".eval_pack.acceptance_refs", requiredManifestRepoPath),
      resultPath: requiredManifestRepoPath(entry.eval_pack.result_path, prefix + ".eval_pack.result_path"),
      primaryMetric: requiredManifestString(entry.eval_pack.primary_metric, prefix + ".eval_pack.primary_metric"),
      maxModelCalls: requiredManifestPositiveInteger(entry.eval_pack.max_model_calls, prefix + ".eval_pack.max_model_calls"),
      maxCostUsd: requiredManifestPositiveNumber(entry.eval_pack.max_cost_usd, prefix + ".eval_pack.max_cost_usd"),
      maxCostPerCallUsd: requiredManifestPositiveNumber(entry.eval_pack.max_cost_per_call_usd, prefix + ".eval_pack.max_cost_per_call_usd"),
      timeoutMinutes: requiredManifestPositiveInteger(entry.eval_pack.timeout_minutes, prefix + ".eval_pack.timeout_minutes"),
      secretEnv: Array.isArray(entry.eval_pack.secret_env) ? requiredManifestUniqueList(entry.eval_pack.secret_env, prefix + ".eval_pack.secret_env") : []
    } : null;
    if (executable && executable.runtime !== "node" && executable.runtime !== "bun") throw new Error(prefix + ".eval_pack.runtime must be node or bun");
    if (executable && executable.runtime === "bun" && executable.lockfile !== "bun.lock" && executable.lockfile !== "bun.lockb") throw new Error(prefix + ".eval_pack.lockfile must be bun.lock or bun.lockb for Bun");
    if (executable && executable.runtime === "node" && executable.lockfile !== "package-lock.json" && executable.lockfile !== "npm-shrinkwrap.json") throw new Error(prefix + ".eval_pack.lockfile must be package-lock.json or npm-shrinkwrap.json for Node");
    if (executable && executable.secretEnv.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name) || /^(BENCHROUTER|ACTIONS|GITHUB)_/.test(name))) throw new Error(prefix + ".eval_pack.secret_env contains a reserved or invalid name");
    if (executable && executable.maxCostPerCallUsd > executable.maxCostUsd) throw new Error(prefix + ".eval_pack.max_cost_per_call_usd must not exceed max_cost_usd");
    if (executable && executable.timeoutMinutes > 350) throw new Error(prefix + ".eval_pack.timeout_minutes must not exceed 350");
    if (executable && executable.acceptanceRefs.some((path) => executable.inputRefs.includes(path))) throw new Error(prefix + ".eval_pack.input_refs and acceptance_refs must not overlap");
    return {
      routeId: requiredManifestString(entry.route_id, prefix + ".route_id"),
      slug: requiredManifestString(entry.id, prefix + ".id"),
      name: requiredManifestString(entry.name, prefix + ".name"),
      codeRefs: Array.isArray(entry.code_refs) ? entry.code_refs.map((value, refIndex) => requiredManifestString(value, prefix + ".code_refs[" + refIndex + "]")) : [],
      evalArchetype: typeof entry.metadata.eval_archetype === "string" ? entry.metadata.eval_archetype : "",
      baseUrlEnv: typeof entry.call_site.base_url_env === "string" ? entry.call_site.base_url_env : "",
      providerId: typeof entry.call_site.provider_id === "string" ? entry.call_site.provider_id : "",
      providerRef: typeof entry.call_site.provider_ref === "string" ? entry.call_site.provider_ref : "",
      bestModel: requiredManifestString(entry.seed.incumbent_model, prefix + ".seed.incumbent_model"),
      evalConfigPath: requiredManifestRepoPath(entry.eval_pack.config_path, prefix + ".eval_pack.config_path"),
      workflowPath: requiredManifestRepoPath(entry.eval_pack.workflow, prefix + ".eval_pack.workflow"),
      evalCommand: requiredManifestString(entry.eval_pack.command, prefix + ".eval_pack.command"),
      evalMode: mode,
      executable,
      evalPack: entry.eval_pack,
      captureCommand: typeof entry.eval_pack.capture_command === "string" ? entry.eval_pack.capture_command : "",
      scorerPath: requiredManifestRepoPath(entry.eval_pack.scorer, prefix + ".eval_pack.scorer"),
      resultSchema: requiredManifestString(entry.eval_pack.result_schema, prefix + ".eval_pack.result_schema"),
      caseRefs,
      casesPath: caseRefs[0],
      calibrationPath: ".benchrouter/calibration." + requiredManifestString(entry.id, prefix + ".id").split("/").join("__") + ".json"
    };
  });
  if (normalizedRoutes.length === 0) throw new Error(configPath + " must declare at least one route");
  return {
    product: {
      slug: requiredManifestString(product.slug, configPath + ".product.slug"),
      repo: requiredManifestString(product.repo, configPath + ".product.repo"),
      defaultBranch: requiredManifestString(product.default_branch, configPath + ".product.default_branch")
    },
    routes: normalizedRoutes
  };
}

async function readBenchRouterManifest(configPath = ".benchrouter/benchrouter.yml") {
  return parseBenchRouterManifest(await readFile(configPath, "utf8"), configPath);
}

const RESPONSE_FORMAT_UNHONORED = "response_format_unhonored";
const FAILURE_CODES = {"transportFetchFailed":"transport_fetch_failed","upstreamTimeout":"upstream_timeout","upstreamHttpError":"upstream_http_error","providersExhausted":"providers_exhausted","judgeUnavailable":"judge_unavailable","scorerException":"scorer_exception","sandboxViolation":"sandbox_violation","unknown":"unknown"};
const CONCURRENCY = Math.max(1, Number(process.env.BENCHROUTER_EVAL_CONCURRENCY) || 5);
// Per-judge-call wall-time cap. A slow (e.g. reasoning) judge model would otherwise
// run away inside the model measurement and fail the job on latency. Capping each
// judge call keeps a slow judge from blowing the job timeout — a timed-out judge fails its case cleanly
// (caught → error → the unevaluableCases gate blocks promotion; never a fake-green).
const JUDGE_TIMEOUT_MS = Math.max(1000, Number(process.env.BENCHROUTER_JUDGE_TIMEOUT_MS) || 60000);
// The Worker already bounds each provider attempt. This slightly wider client deadline
// prevents a lost/hung response from stalling the whole eval while giving the Worker time
// to finish and persist an idempotent response before the runner retries it.
const MODEL_TIMEOUT_MS = Math.max(1000, Number(process.env.BENCHROUTER_MODEL_TIMEOUT_MS) || 135000);
const MODEL_TRANSPORT_RETRIES = 1;
// Sandbox deadlines so an extracted scorer can't hang the model run. Load timeout
// bounds the synchronous module evaluation; the score() deadline bounds each
// per-case call incl. its async judge round-trips. KNOWN LIMITATION (follow-up):
// a SYNCHRONOUS infinite loop inside score() starves the event loop, so this
// timer can't fire — only the GitHub Actions job timeout stops it. Interrupting
// sync loops needs a worker_thread/subprocess re-architecture; deferred as low
// severity (self-DoS in the customer's own CI, job-timeout backstop).
const SCORER_LOAD_TIMEOUT_MS = Math.max(1000, Number(process.env.BENCHROUTER_SCORER_LOAD_TIMEOUT_MS) || 5000);
const SCORER_SCORE_TIMEOUT_MS = Math.max(1000, Number(process.env.BENCHROUTER_SCORER_TIMEOUT_MS) || 20000);
function withDeadline(value, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label + " (" + ms + "ms)")), ms);
        Promise.resolve(value).then((resolved) => { clearTimeout(timer); resolve(resolved); }, (rejected) => { clearTimeout(timer); reject(rejected); });
    });
}
async function fetchWithTransportRetry(url, init, timeoutMs, retries, stage) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...init, signal: controller.signal });
        }
        catch (error) {
            lastError = controller.signal.aborted
                ? codedFailure("upstream timed out", FAILURE_CODES.upstreamTimeout, stage, error)
                : error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    throw lastError || codedFailure("fetch failed", FAILURE_CODES.transportFetchFailed, stage);
}
function codedFailure(message, errorCode, stage, cause) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    error.benchrouter_error_code = errorCode;
    error.benchrouter_stage = stage;
    return error;
}
function safeCausePart(value) {
    return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null;
}
function cleanMessage(value, fallback) {
    const text = typeof value === "string" ? value : fallback;
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, 500) || fallback;
}
function technicalFailure(error, defaultStage) {
    const stage = error && typeof error === "object" && typeof error.benchrouter_stage === "string" ? error.benchrouter_stage : defaultStage;
    const taggedCode = error && typeof error === "object" && typeof error.benchrouter_error_code === "string" ? error.benchrouter_error_code : null;
    const code = taggedCode || ((stage === "model_call" || stage === "judge") ? FAILURE_CODES.transportFetchFailed : stage === "scorer" ? FAILURE_CODES.scorerException : FAILURE_CODES.unknown);
    const cause = error && typeof error === "object" && error.cause && typeof error.cause === "object" ? error.cause : null;
    const canonical = code === FAILURE_CODES.transportFetchFailed ? "fetch failed" : code === FAILURE_CODES.upstreamTimeout ? "upstream timed out" : null;
    return {
        stage, error_code: code,
        cause_code: safeCausePart(cause && cause.code),
        cause_name: safeCausePart(cause && cause.name),
        message: cleanMessage(canonical || (error && error.message), "evaluation infrastructure failed")
    };
}
// Once eval secrets are captured into closures, remove them from process.env so a
// (defensively-improbable) scorer sandbox escape can't read them. fetch calls use
// the captured closures, not process.env, so this never breaks the run.
function scrubEvalSecrets() {
    delete process.env.BENCHROUTER_API_KEY;
    delete process.env.BENCHROUTER_UPLOAD_TOKEN;
    delete process.env.BENCHROUTER_EVAL_CALL_TOKEN_MODEL;
    delete process.env.BENCHROUTER_EVAL_CALL_TOKEN_JUDGE;
}
async function runWithLimit(items, limit, work) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = idx++;
            if (i >= items.length)
                return;
            results[i] = await work(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}
async function main() {
    const apiUrl = (process.env.BENCHROUTER_API_URL || "https://api.benchrouter.com").replace(/\/+$/, "");
    const resultSetId = process.env.BENCHROUTER_RESULT_SET_ID || "";
    const modelRunId = process.env.BENCHROUTER_MODEL_RUN_ID || "";
    const uploadResults = process.env.BENCHROUTER_UPLOAD_RESULTS === "1";
    const runId = modelRunId || process.env.GITHUB_RUN_ID || "local";
    const manifest = await readBenchRouterManifest(process.env.BENCHROUTER_CONFIG_PATH || ".benchrouter/benchrouter.yml");
    // Preview routes are gone: PR and main share one canonical route id.
    const routeId = process.env.BENCHROUTER_ROUTE_ID || (manifest.routes.length === 1 ? manifest.routes[0].routeId : "");
    if (!routeId) throw new Error("BENCHROUTER_ROUTE_ID is required when benchrouter.yml declares multiple routes");
    const baseRouteId = process.env.BENCHROUTER_BASE_ROUTE_ID || routeId;
    const route = manifest.routes.find((entry) => entry.routeId === baseRouteId);
    if (!route) throw new Error("Route " + baseRouteId + " is not declared in benchrouter.yml");
    const model = process.env.BENCHROUTER_FORCE_MODEL || route.bestModel;
    const casesPath = process.env.BENCHROUTER_CASES_PATH || route.casesPath;
    const scorerPath = process.env.BENCHROUTER_SCORER_PATH || route.scorerPath;
    const judgeModel = process.env.BENCHROUTER_JUDGE_MODEL || "";
    const evalCallTokens = {
        model: process.env.BENCHROUTER_EVAL_CALL_TOKEN_MODEL || "",
        judge: process.env.BENCHROUTER_EVAL_CALL_TOKEN_JUDGE || ""
    };
    // Secrets are now captured in closures (apiKey, evalCallTokens) —
    // remove them from process.env so the scorer (loaded next) can't read them even
    // via an escape.
    scrubEvalSecrets();
    await mkdir(".benchrouter", { recursive: true });
    let score;
    try {
        score = await loadScorer(scorerPath);
    } catch (scorerLoadError) {
        const errorCode = scorerLoadError && typeof scorerLoadError === "object" && typeof scorerLoadError.benchrouter_error_code === "string" ? scorerLoadError.benchrouter_error_code : FAILURE_CODES.scorerException;
        throw codedFailure("scorer failed to load", errorCode, "harness", scorerLoadError);
    }
    const allCases = await readCases(casesPath);
    const cases = selectCasesForRoute(allCases, baseRouteId).filter(isRunnableCase);
    assertRealEvalCoverage(cases, baseRouteId);
    function evalHeaders(callKind) {
        const headers = {
            "content-type": "application/json",
            "x-benchrouter-force-model": callKind === "judge" ? (judgeModel || model) : model
        };
        const evalCallToken = evalCallTokens[callKind] || "";
        if (evalCallToken) {
            headers["x-benchrouter-eval-call-token"] = evalCallToken;
        }
        if (modelRunId && uploadResults) {
            if (!evalCallToken) {
                throw new Error("BenchRouter official eval is missing server-issued " + callKind + " eval call token");
            }
            headers["x-benchrouter-result-set-id"] = resultSetId;
            headers["x-benchrouter-model-run-id"] = modelRunId;
        }
        return headers;
    }
    const rows = await runWithLimit(cases, CONCURRENCY, async (testCase) => {
        const started = Date.now();
        const mode = testCase.mode === "trajectory" ? "trajectory" : "isolated";
        let selectedModel = null;
        let modelCallId = null;
        let pass = false;
        let costUsd = null;
        let judgeCostUsd = 0;
        let checks = [];
        let reasons = [];
        let error = null;
        let failure = null;
        let outcomeCode = null;
        let activeStage = "model_call";
        // The model's raw output the scorer judged — persisted for free re-judge.
        let rawOutput = null;
        // The MODEL call's wall time only (item 2): the reported latency must be the
        // model's response time, NOT the whole case (which also includes the local scorer
        // + the separate judge round-trips). Counting scorer/judge time would let the
        // judge model choice corrupt model latency evidence.
        let modelLatencyMs = null;
        // Injected judge client: the ONLY outbound path a sandboxed scorer may use.
        // The server-issued judge call token makes the proxy tag it as judge traffic
        // so its spend is excluded from measured model cost.
        async function benchrouterJudge(messages) {
            activeStage = "judge";
            if (!judgeModel) {
                // P1.1 degrade: no judge model configured. Throw a clear, actionable error
                // (caught per-case below ⇒ this case is flagged, the eval still completes
                // for the rest) rather than a confusing TypeError. Set a server-side
                // default judge model to enable semantic judging.
                throw codedFailure("judge unavailable", FAILURE_CODES.judgeUnavailable, "judge");
            }
            // Cap the judge call's wall time (item 2): a slow/hung reasoning judge would
            // otherwise run the model measurement into its job timeout (judge cost is
            // excluded from model cost, but its wall time is not). A timed-out judge fails THIS
            // case cleanly (→ error → unevaluableCases gate blocks promotion; no fake-green).
            let text = "";
            const judgeController = new AbortController();
            const judgeTimer = setTimeout(() => judgeController.abort(), JUDGE_TIMEOUT_MS);
            try {
                const resp = await fetch(apiUrl + "/v1/chat/completions", {
                    method: "POST",
                    headers: evalHeaders("judge"),
                    body: JSON.stringify({ model: routeId, messages, temperature: 0 }),
                    signal: judgeController.signal
                });
                text = await resp.text();
                if (!resp.ok) {
                    throw codedFailure("upstream HTTP " + resp.status, FAILURE_CODES.upstreamHttpError, "judge");
                }
            }
            catch (judgeErr) {
                if (judgeController.signal.aborted) {
                    throw codedFailure("upstream timed out", FAILURE_CODES.upstreamTimeout, "judge", judgeErr);
                }
                throw judgeErr;
            }
            finally {
                clearTimeout(judgeTimer);
            }
            const parsed = parseJsonObject(text);
            const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
            const jc = numberValue(usage.cost ?? usage.total_cost);
            if (jc !== null)
                judgeCostUsd += jc;
            // Empty-content fallback (item 1): reasoning models often leave message.content
            // empty and put text in reasoning_content / reasoning. Fall back to those; if all
            // empty, throw a SELF-DIAGNOSING error naming the model rather than the generic
            // "no message content".
            const judgeMessage = parsed.choices?.[0]?.message;
            const judgment = stringValue(judgeMessage?.content) ||
                stringValue(judgeMessage?.reasoning_content) ||
                stringValue(judgeMessage?.reasoning);
            if (!judgment) {
                throw codedFailure("judge returned empty content", FAILURE_CODES.judgeUnavailable, "judge");
            }
            activeStage = "scorer";
            return judgment;
        }
        try {
            // Replay the FULL captured request verbatim (tools/response_format/params
            // preserved) to the captured endpoint, forced to the planned model.
            const endpoint = replayEndpoint(testCase);
            activeStage = "model_call";
            const callStarted = Date.now();
            const modelHeaders = evalHeaders("model");
            if (modelRunId && uploadResults) {
                modelHeaders["x-benchrouter-idempotency-key"] = modelCallIdempotencyKey(modelRunId, testCase);
            }
            const response = await fetchWithTransportRetry(apiUrl + endpoint, {
                method: "POST",
                headers: modelHeaders,
                body: JSON.stringify(buildReplayBody(testCase, routeId))
            }, MODEL_TIMEOUT_MS, modelRunId && uploadResults ? MODEL_TRANSPORT_RETRIES : 0, "model_call");
            selectedModel = response.headers.get("x-benchrouter-selected-model");
            modelCallId = response.headers.get("x-benchrouter-model-call-id");
            const text = await response.text();
            // Model-call wall time only — measured before the scorer/judge run.
            modelLatencyMs = Date.now() - callStarted;
            if (!response.ok) {
                error = "upstream HTTP " + response.status;
                failure = { stage: "model_call", error_code: FAILURE_CODES.upstreamHttpError, cause_code: null, cause_name: null, message: error };
            }
            else {
                const parsed = parseJsonObject(text);
                // Store the FULL structured assistant message (content + tool_calls + ...),
                // not text-only, so re-judge + tool-calling routes are lossless (Codex #5).
                const message = extractAssistantMessage(parsed);
                rawOutput = message;
                const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
                costUsd = numberValue(usage.cost ?? usage.total_cost);
                if (!modelCallId) {
                    error = "BenchRouter response missing x-benchrouter-model-call-id";
                    failure = { stage: "harness", error_code: FAILURE_CODES.unknown, cause_code: null, cause_name: null, message: error };
                }
                else {
                    activeStage = "scorer";
                    const result = await Promise.resolve(score({
                    // output = the model's TEXT (assistant content) for content routes.
                    // Tool-calling routes read the full structured message via
                    // metadata.message.tool_calls (the lossless raw_output is message JSON).
                    request: testCase.request,
                    output: messageContent(message),
                    reference: messageContent(testCase.reference_output ?? null),
                    // judge is the scorer's ONLY permitted outbound path (proxy judge
                    // call, server-token-tagged judge traffic, cost bucketed separately). ALWAYS
                    // injected (P1.1): when no judge model is configured, benchrouterJudge
                    // throws a CLEAR, actionable error BEFORE any outbound call, so a
                    // scorer that needs a judge degrades to a labeled per-case error
                    // ("configure a judge model") instead of an opaque "metadata.judge is
                    // not a function" TypeError — and the eval still completes for every
                    // other case. The membrane only ever exchanges strings, so exposing a
                    // throws-when-unconfigured callable adds no escape surface.
                    metadata: {
                        case_id: testCase.id,
                        message: parseMessage(message),
                        reference_message: parseMessage(testCase.reference_output ?? null),
                        ...(testCase.scorer_metadata || {}),
                        judge: benchrouterJudge
                    }
                    }));
                    pass = result.pass === true;
                    checks = Array.isArray(result.checks) ? result.checks.map(String) : [];
                    reasons = Array.isArray(result.reasons) ? result.reasons.map(String) : [];
                    if (!pass && reasons.length === 0) {
                        reasons = ["scorer rejected the model output"];
                    }
                    if (!pass) {
                        const responseFormatReason = responseFormatUnhonoredReason(testCase, message, reasons);
                        if (responseFormatReason) {
                            reasons = appendUnique(reasons, RESPONSE_FORMAT_UNHONORED);
                            error = responseFormatReason;
                            outcomeCode = RESPONSE_FORMAT_UNHONORED;
                        }
                    }
                }
            }
        }
        catch (caught) {
            // A scorer/judge throw can originate in the vm sandbox realm, where the thrown
            // value is NOT `instanceof` the host Error — so read .message defensively, or
            // the real reason (e.g. "judge unavailable: no judge model configured") is lost
            // and surfaces as a useless generic string.
            const caughtMessage = caught && typeof caught.message === "string"
                ? caught.message
                : null;
            // Fall back to the stringified value (not a hardcoded label) so a thrown
            // string / non-Error object still surfaces its real content (Codex P1).
            error = caughtMessage || String(caught);
            failure = technicalFailure(caught, activeStage);
            error = failure.message;
        }
        return {
            run_id: runId,
            route_id: routeId,
            case_id: testCase.id,
            case_version: caseVersion(testCase),
            critical: testCase.critical === true,
            mode,
            model,
            selected_model: selectedModel,
            model_call_ids: modelCallId ? [modelCallId] : [],
            pass,
            score: pass ? 1 : 0,
            checks,
            reasons,
            raw_output: rawOutput,
            reference_output: testCase.reference_output ?? null,
            cost_usd: costUsd,
            judge_cost_usd: judgeCostUsd > 0 ? judgeCostUsd : null,
            // Report the model-call latency (item 2); fall back to whole-case time only if
            // the model call threw before it was measured (an errored case anyway).
            latency_ms: modelLatencyMs ?? (Date.now() - started),
            error,
            outcome_code: outcomeCode,
            technical_failure: failure
        };
    });
    const resultSuffix = resultFileSuffix();
    await writeJsonl(path.join(".benchrouter", "results." + resultSuffix + ".jsonl"), rows);
    assertAcceptedEvidence(rows);
}
function resultFileSuffix() {
    const suffix = process.env.BENCHROUTER_RESULTS_SUFFIX || process.env.BENCHROUTER_MODEL_RUN_ID || process.env.BENCHROUTER_FORCE_MODEL || "model";
    return suffix.replace(/[^A-Za-z0-9_.-]/g, "_");
}
// Loads the extracted contract-scorer behind an AIRTIGHT in-process MEMBRANE.
//
// Two escape surfaces are both closed:
//   (1) GLOBALS — a fresh vm context is its own realm; we inject NO host objects,
//       so `({}).constructor.constructor("return process")()` compiles + runs
//       IN the context (no process/require/fetch) and can't reach the host.
//   (2) ARGUMENTS — score() must NOT receive host-realm objects, or
//       `request.constructor.constructor` walks the host prototype chain to host
//       Function → process. So the DATA args (request/output/reference/metadata)
//       are roundtripped INTO the context (JSON string → JSON.parse in-context):
//       their prototypes are the context's. The one host capability — the judge
//       fn — is wrapped by a CONTEXT function that CLOSES OVER the host callback
//       (a closure var, unreachable via properties or .constructor) and exchanges
//       ONLY strings across the boundary, so no host object ever reaches the
//       scorer. scrubEvalSecrets() + the pull_request trigger are further layers.
async function loadScorer(scorerPath) {
    const source = await readFile(scorerPath, "utf8");
    const sandbox = {};
    vm.createContext(sandbox);
    // Context-side CommonJS shims + a no-op console + a throwing require. Created
    // by code RUN IN the context, so they are context-realm (not host objects).
    vm.runInContext("globalThis.module = { exports: {} };\nglobalThis.exports = globalThis.module.exports;\nglobalThis.require = function (id) {\n  var error = new Error('BenchRouter scorer sandbox: require/import is forbidden (attempted: ' + id + ')');\n  error.benchrouter_error_code = 'sandbox_violation';\n  error.benchrouter_stage = 'scorer';\n  throw error;\n};\nglobalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };", sandbox, { timeout: SCORER_LOAD_TIMEOUT_MS });
    // Evaluate the scorer as a CommonJS module factory, in-context, time-bounded.
    const factory = vm.runInContext("(function (module, exports, require) {\n" + source + "\n})", sandbox, { filename: scorerPath, timeout: SCORER_LOAD_TIMEOUT_MS });
    const ctxModule = sandbox.module;
    factory(ctxModule, ctxModule.exports, sandbox.require);
    // Context-side membrane: a runner that parses host-supplied DATA in-context and
    // a judge factory that closes over the (unreachable) host callback. Defined by
    // code RUN IN the context, so all of it is context-realm.
    vm.runInContext("globalThis.__benchrouter_scorer = (globalThis.module.exports && typeof globalThis.module.exports.score === 'function') ? globalThis.module.exports.score : (globalThis.benchrouterScorer && globalThis.benchrouterScorer.score);\nglobalThis.__benchrouter_makeJudge = function (hostJudge) {\n  return async function judge(messages) {\n    var payload;\n    try { payload = JSON.stringify(messages); } catch (stringifyErr) {\n      throw new Error('judge messages are not serializable');\n    }\n    if (typeof payload !== 'string') { payload = 'null'; }\n    var reply;\n    try {\n      reply = await hostJudge(payload);\n    } catch (hostErr) {\n      throw new Error('judge call failed: ' + (hostErr && hostErr.message ? String(hostErr.message) : String(hostErr)));\n    }\n    return typeof reply === 'string' ? reply : String(reply == null ? '' : reply);\n  };\n};\nglobalThis.__benchrouter_run = async function (payloadJson, judgeWrapper) {\n  var data = JSON.parse(payloadJson);\n  if (judgeWrapper) { if (!data.metadata) data.metadata = {}; data.metadata.judge = judgeWrapper; }\n  if (typeof globalThis.__benchrouter_scorer !== 'function') { throw new Error('scorer score() missing'); }\n  var result = await globalThis.__benchrouter_scorer(data);\n  var checks = result && Array.isArray(result.checks) ? result.checks.map(String) : [];\n  var reasons = result && Array.isArray(result.reasons) ? result.reasons.map(String) : [];\n  return JSON.stringify({ pass: !!(result && result.pass === true), checks: checks, reasons: reasons });\n};", sandbox, { timeout: SCORER_LOAD_TIMEOUT_MS });
    if (typeof sandbox.__benchrouter_scorer !== "function") {
        throw new Error("Scorer " + scorerPath + " must export score({request,output,reference,metadata}) -> {pass,checks,reasons}");
    }
    const ctxMakeJudge = sandbox.__benchrouter_makeJudge;
    const ctxRun = sandbox.__benchrouter_run;
    // Host-facing wrapper: marshal everything through the membrane. The call sites
    // pass score({request, output, reference, metadata}) exactly as before.
    return (async (input) => {
        const metadata = (input.metadata || {});
        const hostJudge = typeof metadata.judge === "function" ? metadata.judge : null;
        const dataMeta = {};
        for (const key of Object.keys(metadata)) {
            if (key !== "judge")
                dataMeta[key] = metadata[key];
        }
        const payloadJson = JSON.stringify({
            request: input.request,
            output: input.output,
            reference: input.reference,
            metadata: dataMeta
        });
        // The host judge is bridged via a host callback that ONLY ever sees/returns
        // strings; the context judge wrapper closes over it (unreachable by scorer).
        const judgeWrapper = hostJudge
            ? ctxMakeJudge((messagesJson) => hostJudge(JSON.parse(messagesJson)))
            : null;
        const resultJson = await withDeadline(Promise.resolve(ctxRun(payloadJson, judgeWrapper)), SCORER_SCORE_TIMEOUT_MS, "scorer score() exceeded deadline");
        const parsed = JSON.parse(resultJson);
        return {
            pass: parsed.pass === true,
            checks: Array.isArray(parsed.checks) ? parsed.checks.map(String) : [],
            reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : []
        };
    });
}
async function readCases(filePath) {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
        throw new Error(filePath + " must contain a JSON array of declared eval cases");
    }
    return parsed;
}
function selectCasesForRoute(cases, baseRouteId) {
    return cases.filter((testCase) => {
        const route = typeof testCase.route === "string" ? testCase.route.trim() : "";
        return route.length === 0 || route === baseRouteId;
    });
}
// The declared request body replayed verbatim (full fidelity), with model
// overridden to the route id. Falls back to a messages-only body for legacy
// captures. Temperature defaults to 0 ONLY when the app didn't set one.
function buildReplayBody(testCase, routeId) {
    const base = testCase.input && typeof testCase.input === "object"
        ? { ...testCase.input }
        : { messages: testCase.messages || [] };
    base.model = routeId;
    if (base.temperature === undefined) {
        console.debug("BenchRouter: defaulted temperature=0 (route/case omitted it)", {
            route_id: routeId,
            case_id: testCase.id
        });
        base.temperature = 0;
    }
    return base;
}
function responseFormatUnhonoredReason(testCase, storedOutput, reasons) {
    if (!caseRequestedJsonResponseFormat(testCase)) {
        return null;
    }
    const output = messageContent(storedOutput).trim();
    const reasonText = reasons.join(" ");
    const structuralFailure = /\b(?:not json|invalid json|not valid json|malformed|schema|response[_ -]?format|output format|missing required|required field|wrong type|invalid type|type mismatch|expected .* string|expected .* object|unexpected token|parse error|json\.parse)\b/i.test(reasonText);
    const malformedJson = output.length === 0 || !canParseJson(output);
    if (!structuralFailure && !malformedJson) {
        return null;
    }
    return RESPONSE_FORMAT_UNHONORED + ": model could not honor response_format";
}
function caseRequestedJsonResponseFormat(testCase) {
    const input = testCase.input && typeof testCase.input === "object" && !Array.isArray(testCase.input)
        ? testCase.input
        : null;
    const format = input && input.response_format && typeof input.response_format === "object" && !Array.isArray(input.response_format)
        ? input.response_format
        : null;
    if (!format) {
        return false;
    }
    const type = stringValue(format.type).toLowerCase();
    return type.length === 0 || type.includes("json") || typeof format.json_schema === "object";
}
function canParseJson(value) {
    try {
        JSON.parse(value);
        return true;
    }
    catch {
        return false;
    }
}
function appendUnique(values, value) {
    return values.includes(value) ? values : [...values, value];
}
function replayEndpoint(testCase) {
    return typeof testCase.endpoint === "string" && testCase.endpoint.length > 0
        ? testCase.endpoint
        : "/v1/chat/completions";
}
// The FULL assistant message (content + tool_calls + ...) as a JSON string —
// lossless, so re-judge and tool-calling routes lose nothing (Codex #5).
function extractAssistantMessage(parsed) {
    const message = parsed.choices?.[0]?.message;
    if (message && typeof message === "object") {
        return JSON.stringify(message);
    }
    // /responses-style or unknown shapes: wrap the structured output as a message.
    if (parsed.output !== undefined) {
        const content = typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output);
        return JSON.stringify({ role: "assistant", content });
    }
    return "";
}
// Parse a stored value as an assistant-message envelope ({role/content/tool_calls})
// if it is one; else null. Tolerant of legacy plain content strings.
function parseMessage(stored) {
    if (typeof stored !== "string" || stored.length === 0) {
        return null;
    }
    try {
        const obj = JSON.parse(stored);
        if (obj && typeof obj === "object" && !Array.isArray(obj) && ("content" in obj || "tool_calls" in obj || "role" in obj)) {
            return obj;
        }
    }
    catch {
        // not JSON — a plain content string
    }
    return null;
}
// The model's TEXT for content-routes: the message content if the stored value is
// a message envelope, else the value verbatim (legacy plain content string).
function messageContent(stored) {
    if (typeof stored !== "string") {
        return "";
    }
    const message = parseMessage(stored);
    return message ? stringValue(message.content) : stored;
}
// Runnable = a real declared case: non-empty id AND a replayable body (full
// `input` or a non-empty legacy `messages` array). Shape-example / docs
// entries (no id/body) are skipped.
function isRunnableCase(testCase) {
    const hasInput = !!testCase.input && typeof testCase.input === "object" && Object.keys(testCase.input).length > 0;
    const hasMessages = Array.isArray(testCase.messages) && testCase.messages.length > 0;
    return typeof testCase.id === "string" && testCase.id.length > 0 && (hasInput || hasMessages);
}
function assertRealEvalCoverage(cases, baseRouteId) {
    if (cases.length === 0) {
        throw new Error("No runnable eval cases found for route " + JSON.stringify(baseRouteId) +
            " - add declared cases from mined tests/code intent or run `benchrouter capture` locally before opening the PR. The eval replays declared inputs against planned models; an empty case set is a no-op.");
    }
}
function assertAcceptedEvidence(rows) {
    const missing = rows
        .filter((row) => row.model_call_ids.length === 0 || row.technical_failure)
        .map((row) => row.case_id + (row.error ? " (" + row.error + ")" : ""));
    if (missing.length > 0) {
        throw new Error("BenchRouter model run contains non-scorable case failures: " + missing.slice(0, 10).join(", "));
    }
}
function caseVersion(testCase) {
    return "sha256:" + hashString(JSON.stringify(testCase));
}
function hashString(value) {
    return createHash("sha256").update(value).digest("hex");
}
function modelCallIdempotencyKey(modelRunId, testCase) {
    return createHash("sha256")
        .update(modelRunId)
        .update("\0")
        .update(String(testCase.id || ""))
        .update("\0")
        .update(caseVersion(testCase))
        .digest("hex");
}
async function writeJsonl(filePath, rows) {
    await writeFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
function parseJsonObject(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function stringValue(value) {
    return typeof value === "string" ? value : "";
}
function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function requiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(name + " is required");
    }
    return value;
}
main().catch(async (error) => {
    console.error(error);
    try {
        await mkdir(".benchrouter", { recursive: true });
        await writeFile(path.join(".benchrouter", "run-error." + resultFileSuffix() + ".json"), JSON.stringify(technicalFailure(error, "harness")) + "\n");
    } catch (sidecarError) {
        console.error("BenchRouter could not write run-error sidecar", sidecarError);
    }
    process.exitCode = 1;
});
