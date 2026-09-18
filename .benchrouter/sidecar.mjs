#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";

const apiUrl = (process.env.BENCHROUTER_API_URL || "https://api.benchrouter.com").replace(/\/+$/, "");
const apiKey = process.env.BENCHROUTER_API_KEY || "";
// OPTIONAL eval context. When present the sidecar authenticates with a
// server-issued eval-call token in the normal Authorization slot so the
// per-(request_fingerprint, model) cache is seeded during
// capture. Absent ⇒ plain route resolution (the route's best model = the
// current best model at capture time). Either way the captured reference_output is real.
const modelRunId = process.env.BENCHROUTER_MODEL_RUN_ID || "";
const evalCallToken = process.env.BENCHROUTER_EVAL_CALL_TOKEN || process.env.BENCHROUTER_EVAL_CALL_TOKEN_MODEL || "";
// Capture provenance for the server's non-blocking "re-capture recommended"
// drift advisory. The capture entrypoint (which has repo FS access) MUST compute
// this with the SAME scheme the server's drift recompute + evalSpecForRoute use:
//   sha256(canonicalJson(sorted([{ path, sha256(fileContent) } for each code_ref])))
// at the eval ref. The sidecar stores it verbatim (no transform) — a mismatched
// scheme only makes the advisory useless, it never breaks the eval.
const codeRefsSha256 = process.env.BENCHROUTER_CODE_REFS_SHA256 || "";
const samplesTarget = Math.max(1, Number(process.env.BENCHROUTER_CAPTURE_SAMPLES) || 1);
const portFile = process.env.BENCHROUTER_SIDECAR_PORT_FILE || ".benchrouter/sidecar.port";
const rawLogPath = process.env.BENCHROUTER_CAPTURE_RAW_LOG || ".benchrouter/captured.jsonl";
const redactPaths = parseRedactPaths(process.env.BENCHROUTER_CAPTURE_REDACT_PATHS);

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
      apiFamily: requiredManifestString(entry.eval_pack.api_family, prefix + ".eval_pack.api_family"),
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
    if (executable && executable.apiFamily !== "openai_chat_completions" && executable.apiFamily !== "anthropic_messages" && executable.apiFamily !== "openai_responses") throw new Error(prefix + ".eval_pack.api_family must be openai_chat_completions, anthropic_messages, or openai_responses");
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


if (!apiKey) {
  console.error("BenchRouter capture sidecar requires BENCHROUTER_API_KEY");
  process.exit(1);
}

// Secret prefixes redacted on sight, structure preserved. NOT exhaustive — the
// install agent reviews every redaction and flags anything unsafe to retain.
const SECRET_PREFIXES = [
  "sk-", "sk-ant-", "br_", "ghp_", "gho_", "ghs_", "github_pat_",
  "xoxb-", "xoxp-", "xoxa-", "AKIA", "ASIA", "AIza", "ya29.", "Bearer "
];
const REDACTED = "[[benchrouter:redacted]]";

// Per-route case sets: route -> Map(caseId -> case). Loaded lazily from any
// existing cases.<token>.json so repeated capture runs ACCUMULATE samples (the
// contract is the invariant across samples, never one run's wording).
const routeCaseSets = new Map();
const routeLoaded = new Set();

// route_id (what the app sends as `model`) -> generated kit route slug.
// The kit's REPLAY + the server's drift derive per-route filenames from the
// SLUG (constants.ts casesPathFor / upload-helper resolveRoutePaths). The sidecar
// only sees route_id, so it MUST map route_id->slug from canonical benchrouter.yml
// and write the token from the SLUG — otherwise, for any route where id != route_id,
// capture would write a file the replay can never find (silent empty eval). Same
// source for write-token and read-token = impossible-by-construction.
const routeIdToSlug = new Map();
let routeIndexLoaded = false;

async function ensureRouteIndex() {
  if (routeIndexLoaded) return;
  routeIndexLoaded = true;
  const manifest = await readBenchRouterManifest(process.env.BENCHROUTER_CONFIG_PATH || ".benchrouter/benchrouter.yml");
  for (const route of manifest.routes) routeIdToSlug.set(route.routeId, route.slug);
}

function routeToken(route) {
  const slug = routeIdToSlug.get(route) || route;
  return String(slug || "default").split("/").join("__");
}
function casesPathForRoute(route) {
  return ".benchrouter/cases." + routeToken(route) + ".json";
}
function capturePathForRoute(route) {
  return ".benchrouter/capture." + routeToken(route) + ".json";
}

function parseRedactPaths(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Canonical JSON for a stable case id: recursively sort object keys, preserve
// array order. Matches the spirit of the proxy's request_fingerprint so the same
// request maps to the same captured case across runs.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value === undefined ? null : value);
}

function looksLikeSecret(text) {
  if (typeof text !== "string") return false;
  for (const prefix of SECRET_PREFIXES) {
    if (text.startsWith(prefix) && text.length >= prefix.length + 8) return true;
  }
  return false;
}

// Deep, STRUCTURE-PRESERVING redaction: walk the value; tokenize string leaves
// that match a known secret prefix or a caller-declared dot-path. Records every
// redaction as { path, kind } and never alters shape (keys/arrays stay). No
// regex — prefix/path checks only.
function redact(value, basePath, redactions) {
  if (Array.isArray(value)) {
    return value.map((item, i) => redact(item, basePath + "[" + i + "]", redactions));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      const childPath = basePath ? basePath + "." + key : key;
      out[key] = redact(value[key], childPath, redactions);
    }
    return out;
  }
  if (typeof value === "string") {
    // A declared path redacts that leaf AND all its descendants: "metadata"
    // redacts metadata.api_key, metadata.nested[0].token, etc. (Codex #6).
    const declared = redactPaths.some(
      (p) => basePath === p || basePath.startsWith(p + ".") || basePath.startsWith(p + "[")
    );
    if (declared) {
      redactions.push({ path: basePath, kind: "declared" });
      return REDACTED;
    }
    if (looksLikeSecret(value)) {
      redactions.push({ path: basePath, kind: "secret" });
      return REDACTED;
    }
  }
  return value;
}

// The exact request the app emitted, minus every BenchRouter SELECTOR and minus
// known client-injected volatile ids, so the captured input replays faithfully,
// dedupes stably, and passes the narrower eval ingress contract.
//
// `route`, `model`, `provider`, and `allow_fallbacks` are BenchRouter routing
// controls, not protocol payload. They are stripped from the stored replay body
// and the normalized routing context is recorded separately as bounded case
// metadata.
const ROUTING_SELECTOR_KEYS = ["route", "model", "provider", "allow_fallbacks"];
const VOLATILE_BODY_KEYS = [...ROUTING_SELECTOR_KEYS, "idempotency_key", "request_id", "trace_id", "x_request_id", "user"];
function normalizeInput(body) {
  if (!body || typeof body !== "object") return {};
  const input = {};
  for (const key of Object.keys(body)) {
    if (!VOLATILE_BODY_KEYS.includes(key)) input[key] = body[key];
  }
  return input;
}

// Bounded routing context for the captured case. Names only, never values that
// could carry prompt or user data.
function routingContext(body) {
  if (!body || typeof body !== "object") return {};
  const context = {};
  if (typeof body.route === "string") context.route = body.route;
  if (typeof body.model === "string") context.model = body.model;
  return context;
}

// ROUTE-001: the ADMITTED Anthropic protocol headers are protocol inputs, not
// transparent proxy headers. Replay preserves them as case inputs.
// Only these two names are read; no other request header is
// captured or forwarded.
const PROTOCOL_HEADER_NAMES = ["anthropic-version", "anthropic-beta"];
function protocolHeaders(requestHeaders) {
  const captured = {};
  if (!requestHeaders || typeof requestHeaders !== "object") return captured;
  for (const name of PROTOCOL_HEADER_NAMES) {
    const value = requestHeaders[name];
    if (typeof value === "string" && value.length > 0) captured[name] = value;
  }
  return captured;
}

// The FULL assistant message (content + tool_calls + ...) — captured losslessly
// so tool-calling routes and re-judge lose nothing (Codex #5).
//
// SERVE-009: a Responses body keeps its ORDERED output item array and its
// native status verbatim. Wrapping `output` as one assistant content string
// lost refusal and item boundaries, so the captured corpus could never
// authorize function, refusal, reasoning, or strict-output serving.
function extractMessage(responseJson) {
  if (!responseJson || typeof responseJson !== "object") return { role: "assistant", content: "" };
  const choice = Array.isArray(responseJson.choices) ? responseJson.choices[0] : null;
  if (choice && choice.message && typeof choice.message === "object") return choice.message;
  if (Array.isArray(responseJson.output)) {
    return {
      object: "response",
      status: typeof responseJson.status === "string" ? responseJson.status : null,
      output: responseJson.output,
      incomplete_details: responseJson.incomplete_details == null ? null : responseJson.incomplete_details
    };
  }
  return { role: "assistant", content: "" };
}

function extractCost(responseJson) {
  const usage = responseJson && typeof responseJson === "object" ? responseJson.usage : null;
  const cost = usage && typeof usage === "object" ? (usage.cost != null ? usage.cost : usage.total_cost) : null;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

// A request that embeds a PRIOR model/tool output (assistant or tool message) is
// `dependent` — replay treats it as an ISOLATED compatibility check (against the
// current best-model upstream context), never end-to-end (§7.1 Codex #2).
function detectDependent(input) {
  const messages = input && Array.isArray(input.messages) ? input.messages : [];
  return messages.some((m) => m && (m.role === "assistant" || m.role === "tool"));
}

async function loadRoute(route) {
  if (routeLoaded.has(route)) return routeCaseSets.get(route);
  routeLoaded.add(route);
  const map = new Map();
  routeCaseSets.set(route, map);
  try {
    const existing = JSON.parse(await readFile(casesPathForRoute(route), "utf8"));
    if (Array.isArray(existing)) {
      for (const c of existing) {
        if (c && typeof c.id === "string" && (c.input || Array.isArray(c.messages))) map.set(c.id, c);
      }
    }
  } catch {
    // No prior cases file (first capture) — start empty.
  }
  return map;
}

async function persistRoute(route) {
  const map = routeCaseSets.get(route) || new Map();
  const cases = Array.from(map.values());
  await mkdir(".benchrouter", { recursive: true });
  await writeFile(casesPathForRoute(route), JSON.stringify(cases, null, 2) + "\n");
  let redactionCount = 0;
  let maxSamples = 0;
  for (const c of cases) {
    redactionCount += Array.isArray(c.redactions) ? c.redactions.length : 0;
    maxSamples = Math.max(maxSamples, Array.isArray(c.samples) ? c.samples.length : 0);
  }
  const provenance = {
    route,
    source: "benchrouter-capture",
    captured_at: new Date().toISOString(),
    case_count: cases.length,
    code_refs_sha256: codeRefsSha256 || null,
    redaction_count: redactionCount,
    max_samples: maxSamples,
    note: "Local capture. Review redactions; enrich request/scorer_metadata/critical before relying on these cases."
  };
  await writeFile(capturePathForRoute(route), JSON.stringify(provenance, null, 2) + "\n");
}

async function recordCapture(route, input, output, selectedModel, redactions, dependent, endpoint, routing, headers) {
  const map = await loadRoute(route);
  // ROUTE-001: case identity is the body PLUS the protocol identity it was sent
  // under. The same body on /v1/chat/completions and /v1/messages, or under two
  // different admitted Anthropic versions or betas, is TWO evaluated cases; a
  // body-only hash would collapse distinct replay inputs.
  const identity = canonicalJson({ input, endpoint: endpoint || "", headers: headers || {} });
  const id = "case_" + createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const existing = map.get(id);
  if (existing) {
    // Repeated identical input ⇒ accumulate a NEW sample (nondeterminism). The
    // contract is the invariant across samples, so keep distinct outputs.
    existing.samples = Array.isArray(existing.samples) ? existing.samples : [];
    if (!existing.samples.includes(output)) existing.samples.push(output);
    if (selectedModel) existing.selected_model = selectedModel;
    // The identity above already pins these, so they can only be re-asserted.
    existing.endpoint = endpoint;
    existing.headers = headers || {};
    return;
  }
  const messages = Array.isArray(input.messages) ? input.messages : [];
  map.set(id, {
    id,
    route,
    critical: true,
    // The EXACT captured request body replayed verbatim (full fidelity) + the
    // endpoint it hit, so tools/response_format and /responses vs /chat are
    // preserved on replay (Codex #6). messages kept for back-compat/display.
    input,
    routing_context: routing || {},
    // ROUTE-001: preserve admitted Anthropic headers for faithful replay.
    headers: headers || {},
    endpoint,
    messages,
    // Structured app-level input + scorer hints: filled by the install agent.
    request: null,
    scorer_metadata: {},
    // Calibration sample (NOT a gold answer): the FULL assistant message JSON
    // (content + tool_calls), + all captured samples.
    reference_output: output,
    samples: [output],
    selected_model: selectedModel || null,
    // Chain topology (Codex #2): isolated compatibility check by default.
    mode: "isolated",
    dependent,
    // Nondeterminism + snapshot (Codex #3/#4): declared by the dev/agent.
    volatile_fields: [],
    snapshot: false,
    provenance: { source: "benchrouter-capture", captured_at: new Date().toISOString(), code_refs_sha256: codeRefsSha256 || null },
    // Privacy (Codex #5): what was redacted before persisting.
    redactions
  });
}

async function forwardOnce(target, method, body, admittedProtocolHeaders) {
  const headers = {
    authorization: "Bearer " + (modelRunId && evalCallToken ? evalCallToken : apiKey),
    "content-type": "application/json",
    // Capture-only marker (P0.2): the sidecar ONLY ever runs during local capture,
    // so every call it makes must be excluded from runtime traffic observation —
    // the proxy resolves + serves the route normally but skips the wired flip
    // (observeRouteModelCall). Always sent; harmless when a model-run context is
    // also present (eval traffic already skips observation).
    "x-benchrouter-capture": "1"
  };
  // /v1/messages REQUIRES an admitted `anthropic-version`, so a capture that
  // dropped it could never record a Messages case at all.
  for (const name of PROTOCOL_HEADER_NAMES) {
    const value = admittedProtocolHeaders && admittedProtocolHeaders[name];
    if (typeof value === "string" && value.length > 0) headers[name] = value;
  }
  const upstream = await fetch(target, { method, headers, body: body && body.length > 0 ? body : undefined });
  const text = await upstream.text();
  return { upstream, text };
}

const server = createServer(async (req, res) => {
  let body;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400);
    res.end("BenchRouter capture sidecar: failed to read request body");
    return;
  }

  const endpointPath = req.url || "/v1/chat/completions";
  const admittedProtocolHeaders = protocolHeaders(req.headers);
  const target = apiUrl + endpointPath;
  const method = req.method || "POST";
  const requestJson = parseJson(body.toString("utf8"));
  // SERVE-009: capture NEVER records a stream. A streamed body has no single
  // response object to store as the reference output, so the case would be
  // captured from a reconstruction rather than from what the provider sent.
  if (requestJson && requestJson.stream === true) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "BenchRouter capture does not support streaming responses", code: "capture_stream_unsupported" } }));
    return;
  }
  // ROUTE-001: `route` is the selector. `model` is only the route in the
  // one-field SDK form, so reading it first would file a `{route, model}` case
  // under the MODEL's name and split one route's corpus in two.
  const route = requestJson && typeof requestJson.route === "string" && requestJson.route.length > 0
    ? requestJson.route
    : requestJson && typeof requestJson.model === "string" ? requestJson.model : "default";

  let first;
  try {
    // Multi-sample (opt-in): capture samplesTarget outputs for volatile inputs.
    // Only the first response is relayed to the app.
    const outputs = [];
    let selectedModel = null;
    for (let i = 0; i < samplesTarget; i += 1) {
      const result = await forwardOnce(target, method, body, admittedProtocolHeaders);
      if (i === 0) first = result;
      selectedModel = result.upstream.headers.get("x-benchrouter-selected-model") || selectedModel;
      const json = parseJson(result.text);
      // Capture the FULL assistant message (content + tool_calls), not text-only.
      outputs.push({ json, message: extractMessage(json), ok: result.upstream.ok });
    }

    if (requestJson && (first && first.upstream.ok) && outputs[0] && outputs[0].ok) {
      // Resolve route_id->slug from the manifest BEFORE computing any filename, so
      // capture writes the SAME token the replay/drift read (impossible to diverge).
      await ensureRouteIndex();
      const redactions = [];
      const redactedInput = redact(normalizeInput(requestJson), "", redactions);
      const capturedRoutingContext = routingContext(requestJson);
      const dependent = detectDependent(redactedInput);
      for (const sample of outputs) {
        // Redact the message OBJECT (structure-preserving) then store as JSON.
        const redactedOutput = JSON.stringify(redact(sample.message, "reference_output", redactions));
        await recordCapture(route, redactedInput, redactedOutput, selectedModel, redactions, dependent, endpointPath, capturedRoutingContext, admittedProtocolHeaders);
      }
      await persistRoute(route);
      try {
        await appendFile(rawLogPath, JSON.stringify({
          route,
          captured_at: new Date().toISOString(),
          selected_model: selectedModel,
          cost_usd: extractCost(outputs[0].json),
          redaction_count: redactions.length
        }) + "\n");
      } catch (error) {
        console.error("BenchRouter capture sidecar: failed to append raw log", error);
      }
    }
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "BenchRouter capture sidecar upstream fetch failed" } }));
    return;
  }

  // fetch() already decoded the body and we re-emit it as text, so relaying the
  // original content-encoding/length/transfer-encoding would corrupt the
  // response for the app's client. Drop them and let Node recompute length.
  const relayHeaders = {};
  first.upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") return;
    relayHeaders[key] = value;
  });
  res.writeHead(first.upstream.status, relayHeaders);
  res.end(first.text);
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await mkdir(".benchrouter", { recursive: true });
    await writeFile(portFile, String(port));
  } catch (error) {
    console.error("BenchRouter capture sidecar: failed to write port file", error);
  }
  console.log("BenchRouter capture sidecar listening on 127.0.0.1:" + port + " (capture mode)");
});
