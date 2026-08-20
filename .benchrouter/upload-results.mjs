#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const BENCHROUTER_CI_KIT_VERSION = "0.0.10";
const FAILURE_REASON_CODES = {"caseFailures":"case_failures","uploadRejected":"upload_rejected","workflowStepFailed":"workflow_step_failed","dispatchFailed":"dispatch_failed","claimAbandoned":"claim_abandoned","livenessExpired":"liveness_expired","prRerunFailed":"pr_rerun_failed","cancelled":"cancelled"};
const CASE_ERROR_CODES = new Set(["transport_fetch_failed","upstream_timeout","upstream_http_error","providers_exhausted","judge_unavailable","scorer_exception","sandbox_violation","unknown"]);
const FAILURE_STAGES = new Set(["model_call","judge","scorer","harness"]);
const GITHUB_OIDC_REQUEST_ENV = Object.freeze({
  requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
});
delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
// Isolated replay invokes the kit's OWN code-free harness directly by path via
// Node type-stripping and installs no dependencies. The separate explicit
// repository_executable mode runs pinned customer argv only on trusted dispatch.
const REPLAY_HARNESS_PATH = ".benchrouter/benchrouter-eval.mjs";
const REPLAY_HARNESS_COMMAND = "node " + REPLAY_HARNESS_PATH;

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

const execFileAsync = promisify(execFile);

async function main() {
  const command = commandName();
  if (command === "version") {
    console.log(BENCHROUTER_CI_KIT_VERSION);
    return;
  }

  // Diagnostic: compute + print the FILE-derived fingerprint hashes from the local
  // checkout (config / captured case set / scorer) without uploading. Runs the real
  // kit hashing (hashFile + capturedCaseSetSha256 + canonicalJson), so a server-side
  // parity test can assert these match the planner's content hashes — catching a
  // kit↔server canonicalJson drift in CI rather than at the live smoke. Also handy
  // for debugging a rejected upload.
  if (command === "print-fingerprint") {
    console.log(JSON.stringify({
      config_sha256: await hashFile(requiredEnv("BENCHROUTER_CONFIG_PATH")),
      captured_case_set_sha256: await capturedCaseSetSha256(),
      scorer_sha256: await hashFile(requiredEnv("BENCHROUTER_SCORER_PATH"))
    }));
    return;
  }

  const apiUrl = (process.env.BENCHROUTER_API_URL || "https://api.benchrouter.com").replace(/\/+$/, "");

  if (command === "prepare") {
    await prepareContext();
    return;
  }

  if (command === "install-executable") {
    await installExecutableDependencies();
    return;
  }

  if (command === "validate-dispatch") {
    validateWorkflowDispatch();
    return;
  }

  if (command === "routes-matrix") {
    await emitRoutesMatrix();
    return;
  }

  if (command === "plan-pr") {
    await planPullRequestEval(apiUrl);
    return;
  }

  if (command === "import-main") {
    await importDefaultBranchConfig(apiUrl);
    return;
  }

  if (command === "start") {
    const modelRunId = requiredEnv("BENCHROUTER_MODEL_RUN_ID");
    const session = await exchangeUploadToken(apiUrl, modelRunId, await requestGitHubOidcToken(modelRunAudience(modelRunId)));
    if (process.env.GITHUB_ENV) {
      await appendFile(process.env.GITHUB_ENV, [
        "BENCHROUTER_UPLOAD_TOKEN=" + session.uploadToken,
        "BENCHROUTER_EVAL_CALL_TOKEN_MODEL=" + (session.evalCallTokens.model || ""),
        "BENCHROUTER_EVAL_CALL_TOKEN_JUDGE=" + (session.evalCallTokens.judge || "")
      ].join("\n") + "\n");
    }
    console.log("BenchRouter CI kit " + BENCHROUTER_CI_KIT_VERSION + " started model run " + modelRunId);
    return;
  }

  if (command === "run-model") {
    process.exitCode = await runModel(process.env);
    return;
  }

  if (command === "run-pack") {
    await runModelPack(apiUrl);
    return;
  }

  if (command === "run-session") {
    await runAdaptiveSession(apiUrl);
    return;
  }

  if (command === "fail") {
    const modelRunId = requiredEnv("BENCHROUTER_MODEL_RUN_ID");
    const oidcToken = await requestGitHubOidcToken(modelRunAudience(modelRunId));
    await notifyFailure(apiUrl, modelRunId, process.env.BENCHROUTER_UPLOAD_TOKEN || "", oidcToken, false);
    return;
  }

  if (command === "timeout") {
    const modelRunId = requiredEnv("BENCHROUTER_MODEL_RUN_ID");
    const oidcToken = await requestGitHubOidcToken(modelRunAudience(modelRunId));
    await notifyFailure(apiUrl, modelRunId, process.env.BENCHROUTER_UPLOAD_TOKEN || "", oidcToken, true);
    return;
  }

  if (command === "upload-results") {
    await uploadModelResults(apiUrl);
    return;
  }

  if (command === "report-snapshot") {
    await reportRouteSnapshot(apiUrl);
    return;
  }

  throw new Error("Unknown BenchRouter CI command: " + command);
}

function commandName() {
  return process.argv[2] || "";
}

function modelRunAudience(modelRunId) {
  const baseAudience = process.env.BENCHROUTER_OIDC_AUDIENCE || "benchrouter";
  if (baseAudience.includes(":eval-model-run:")) {
    return baseAudience;
  }
  return baseAudience + ":eval-model-run:" + modelRunId;
}

async function emitRoutesMatrix() {
  const isDispatch = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  let include;
  if (isDispatch) {
    // One route+tranche workflow expands to at most four bounded pack jobs.
    const plan = parsePlanJson(requiredEnv("BENCHROUTER_INPUT_PLAN_JSON"));
    const resultSetId = optionalEnv("BENCHROUTER_INPUT_RESULT_SET_ID") || requiredString(plan.result_set_id, "benchrouter_plan.result_set_id");
    const routeId = requiredEnv("BENCHROUTER_INPUT_ROUTE_ID");
    const baseRouteId = optionalEnv("BENCHROUTER_INPUT_BASE_ROUTE_ID") || routeId;
    const models = normalizeModelPlanEntries(plan);
    if (models.length === 0) {
      throw new Error("benchrouter_plan.models must include at least one model entry");
    }
    const recovery = plan.recovery === true;
    if (models.some((member) => !member.tranche_id || !member.pack_id || !Number.isInteger(member.member_ordinal) || !Number.isInteger(member.pack_ordinal))) {
      throw new Error("Workflow dispatch members require durable tranche, pack, and ordinal identity");
    }
    if (!recovery && models.length > 8) {
      throw new Error("A normal BenchRouter tranche may contain at most 8 members");
    }
    const orderedModels = [...models].sort((left, right) => left.member_ordinal - right.member_ordinal);
    const persistedPacks = [...new Map(orderedModels.map((member) => {
      if (!member.tranche_id || !member.pack_id) throw new Error("Pack members require durable tranche and pack identity");
      return [member.pack_id, orderedModels.filter((candidate) => candidate.pack_id === member.pack_id)];
    })).values()];
    if (!recovery && persistedPacks.some((members) => members.length > 2)) {
      throw new Error("A normal BenchRouter pack may contain at most 2 members");
    }
    let route = null;
    try { const manifest = await readBenchRouterManifest(optionalEnv("BENCHROUTER_DEFAULT_CONFIG_PATH") || ".benchrouter/benchrouter.yml"); route = manifest.routes.find((entry) => entry.routeId === baseRouteId) || null; } catch {}
    const timeoutMinutes = route?.evalMode === "repository_executable" ? Math.min(360, route.executable.timeoutMinutes + 10) : recovery ? Math.min(70, Math.max(20, models.length * 10)) : 20;
    include = [];
    for (const members of persistedPacks) {
      const first = members[0];
      include.push({
        route_id: routeId,
        base_route_id: baseRouteId,
        result_set_id: resultSetId,
        tranche_id: first.tranche_id,
        pack_id: first.pack_id,
        job_name: "Testing " + members.map((member) => member.model).join(" + ") + " · " + routeId + " · " + first.pack_id,
        pack_index: first.pack_ordinal - 1,
        recovery,
        timeout_minutes: timeoutMinutes,
        pack_members_json: JSON.stringify(members),
        model: first.model,
        model_run_id: first.model_run_id,
        model_run_action: first.action
      });
    }
  } else {
    const routes = (await readBenchRouterManifest(process.env.BENCHROUTER_DEFAULT_CONFIG_PATH || ".benchrouter/benchrouter.yml")).routes;
    // Each leg carries its route's incumbent model so multi-route scaffolds do not
    // inherit the primary route's model.
    include = routes.map((route) => {
      if (!route.bestModel) {
        throw new Error("Route " + route.routeId + " in benchrouter.yml is missing seed.incumbent_model");
      }
      return {
        route_id: route.routeId,
        incumbent_model: route.bestModel,
        job_name: process.env.GITHUB_EVENT_NAME === "pull_request"
          ? "PR testing route · " + route.routeId
          : "Publishing route configuration · " + route.routeId,
        timeout_minutes: process.env.GITHUB_EVENT_NAME === "pull_request" ? 360 : 20
      };
    });
  }
  const matrix = JSON.stringify({ include });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, "matrix=" + matrix + "\n");
  }
  console.log(matrix);
}

function parsePlanJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error("benchrouter_plan must be valid JSON");
  }
}

function normalizeModelPlanEntries(plan) {
  const rawModels = Array.isArray(plan.models) ? plan.models : [];
  return rawModels.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("benchrouter_plan.models[" + index + "] must be an object");
    }
    const action = typeof entry.action === "string" && entry.action.length > 0 ? entry.action : "run";
    if (!["run", "reuse"].includes(action)) {
      throw new Error("benchrouter_plan.models[" + index + "].action must be run or reuse");
    }
    return {
      model: requiredString(entry.model, "benchrouter_plan.models[" + index + "].model"),
      model_run_id: requiredString(entry.model_run_id, "benchrouter_plan.models[" + index + "].model_run_id"),
      action,
      tranche_id: typeof entry.tranche_id === "string" ? entry.tranche_id : null,
      member_ordinal: Number.isInteger(entry.member_ordinal) ? entry.member_ordinal : null,
      pack_id: typeof entry.pack_id === "string" ? entry.pack_id : null,
      pack_ordinal: Number.isInteger(entry.pack_ordinal) ? entry.pack_ordinal : null
    };
  });
}

async function prepareContext() {
  const isDispatch = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const values = {
    BENCHROUTER_API_URL: isDispatch ? requiredEnv("BENCHROUTER_INPUT_API_URL") : requiredEnv("BENCHROUTER_DEFAULT_API_URL"),
    BENCHROUTER_ROUTE_ID: isDispatch ? requiredEnv("BENCHROUTER_INPUT_ROUTE_ID") : requiredEnv("BENCHROUTER_DEFAULT_ROUTE_ID"),
    // Case selection uses the stable base route id. In the preview-free model
    // dispatches still pass it explicitly; fall back to the matrix route id when
    // BenchRouter omits it (older server).
    BENCHROUTER_BASE_ROUTE_ID: isDispatch
      ? optionalEnv("BENCHROUTER_INPUT_BASE_ROUTE_ID") || requiredEnv("BENCHROUTER_INPUT_ROUTE_ID")
      : requiredEnv("BENCHROUTER_DEFAULT_ROUTE_ID"),
    BENCHROUTER_CONFIG_PATH: isDispatch ? requiredEnv("BENCHROUTER_INPUT_CONFIG_PATH") : requiredEnv("BENCHROUTER_DEFAULT_CONFIG_PATH"),
    BENCHROUTER_EVAL_COMMAND: requiredEnv("BENCHROUTER_FIXED_EVAL_COMMAND"),
    BENCHROUTER_MODEL_ID: isDispatch ? requiredEnv("BENCHROUTER_INPUT_MODEL_ID") : optionalEnv("BENCHROUTER_INPUT_MODEL_ID") || requiredEnv("BENCHROUTER_DEFAULT_INCUMBENT_MODEL"),
    BENCHROUTER_EVAL_REF: isDispatch ? requiredEnv("BENCHROUTER_INPUT_EVAL_REF") : requiredEnv("BENCHROUTER_EVENT_EVAL_REF"),
    BENCHROUTER_RESULT_SCHEMA: "benchrouter.result.v1",
    BENCHROUTER_PLAN_ACTION: "",
    BENCHROUTER_PLAN_REASON: "",
    BENCHROUTER_RESULT_SET_ID: isDispatch ? requiredEnv("BENCHROUTER_INPUT_RESULT_SET_ID") : "",
    BENCHROUTER_DISPATCH_ATTEMPT_ID: isDispatch ? requiredEnv("BENCHROUTER_INPUT_DISPATCH_ATTEMPT_ID") : "",
    BENCHROUTER_MODEL_RUN_ACTION: isDispatch ? requiredEnv("BENCHROUTER_INPUT_MODEL_RUN_ACTION") : "",
    BENCHROUTER_MODEL_RUN_ID: isDispatch ? requiredEnv("BENCHROUTER_INPUT_MODEL_RUN_ID") : "",
    BENCHROUTER_UPLOAD_RESULTS: isDispatch && requiredEnv("BENCHROUTER_INPUT_MODEL_RUN_ACTION") === "run" ? "1" : "0",
    BENCHROUTER_RESULTS_SUFFIX: isDispatch ? safeResultSuffix(requiredEnv("BENCHROUTER_INPUT_MODEL_RUN_ID")) : "",
    // Optional default judge model (P1.1): present only when BenchRouter passes one
    // on dispatch. Empty otherwise — the replay harness then skips judge checks
    // (degrade) instead of throwing.
    BENCHROUTER_JUDGE_MODEL: isDispatch ? optionalEnv("BENCHROUTER_INPUT_JUDGE_MODEL") : optionalEnv("BENCHROUTER_DEFAULT_JUDGE_MODEL")
  };
  const manifest = await readBenchRouterManifest(values.BENCHROUTER_CONFIG_PATH);
  const route = manifest.routes.find((entry) => entry.routeId === values.BENCHROUTER_BASE_ROUTE_ID);
  if (!route) throw new Error("Route " + values.BENCHROUTER_BASE_ROUTE_ID + " is not declared in " + values.BENCHROUTER_CONFIG_PATH);
  values.BENCHROUTER_SCORER_PATH = route.scorerPath;
  values.BENCHROUTER_CASES_PATH = route.casesPath;
  values.BENCHROUTER_EVAL_MODE = route.evalMode;
  if (route.executable) {
    values.BENCHROUTER_EXEC_RUNTIME = route.executable.runtime;
    values.BENCHROUTER_EXEC_RUNTIME_VERSION = route.executable.runtimeVersion;
    values.BENCHROUTER_EXEC_RESULT_PATH = route.executable.resultPath;
    values.BENCHROUTER_RESULT_SCHEMA = route.resultSchema;
  }
  await appendEnv(values);
}

function validateWorkflowDispatch() {
  const required = [
    "BENCHROUTER_API_URL",
    "BENCHROUTER_RESULT_SET_ID",
    "BENCHROUTER_DISPATCH_ATTEMPT_ID",
    "BENCHROUTER_MODEL_RUN_ID",
    "BENCHROUTER_MODEL_RUN_ACTION",
    "BENCHROUTER_ROUTE_ID",
    "BENCHROUTER_CONFIG_PATH",
    "BENCHROUTER_MODEL_ID",
    "BENCHROUTER_EVAL_REF"
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error("BenchRouter workflow_dispatch is missing required planned inputs: " + missing.join(", "));
  }
  if (!["run", "reuse"].includes(process.env.BENCHROUTER_MODEL_RUN_ACTION)) {
    throw new Error("BENCHROUTER_MODEL_RUN_ACTION must be run or reuse for workflow_dispatch");
  }
}

async function planPullRequestEval(apiUrl) {
  const manifest = await readBenchRouterManifest(requiredEnv("BENCHROUTER_CONFIG_PATH"));
  const request = {
    repo_full_name: requiredEnv("BENCHROUTER_REPO_FULL_NAME"),
    config_path: requiredEnv("BENCHROUTER_CONFIG_PATH"),
    ref: requiredEnv("BENCHROUTER_EVAL_REF"),
    route_id: requiredEnv("BENCHROUTER_ROUTE_ID"),
    kit_route_ids: manifest.routes.map((route) => route.routeId),
    kit_version: BENCHROUTER_CI_KIT_VERSION,
    pull_request_number: Number(process.env.BENCHROUTER_PR_NUMBER || 0) || undefined,
    pull_request_url: process.env.BENCHROUTER_PR_URL || undefined,
    pull_request_head_ref: process.env.BENCHROUTER_PR_HEAD_REF || undefined,
    pull_request_head_sha: process.env.BENCHROUTER_PR_HEAD_SHA || undefined
  };
  await writeTempJson("benchrouter-plan-request.json", request);
  const body = await postBenchRouterJson(apiUrl, "/v1/control/eval-plan", request, "eval-plan");
  await writeTempJson("benchrouter-eval-plan.json", body);
  if (!body.ok) {
    throw new Error("BenchRouter did not return an eval plan");
  }
  const outcome = body.outcome;
  if (!outcome || typeof outcome.outcome !== "string") {
    throw new Error("BenchRouter eval plan response is missing outcome");
  }
  if (outcome.outcome === "blocked") {
    throw new Error("BenchRouter blocked eval planning: " + (outcome.reason || "blocked"));
  }
  if (outcome.outcome === "noop" || outcome.outcome === "reuse") {
    const summaryReason = outcome.reason || outcome.outcome;
    console.log("BenchRouter: " + outcome.outcome + " (" + summaryReason + ")");
    await appendStepSummary([
      "## BenchRouter PR plan",
      "",
      "Outcome: " + outcome.outcome + " (" + summaryReason + ").",
      ""
    ]);
    return;
  }
  if (outcome.outcome === "async_dispatched") {
    console.log("BenchRouter: " + (body.plan?.display_name || "route test dispatched") + "; evidence pending");
    await appendStepSummary([
      "## BenchRouter PR plan",
      "",
      "BenchRouter dispatched async eval; evidence pending.",
      "Result set: " + (outcome.result_set_id || ""),
      ""
    ]);
    return;
  }
  if (!body.plan) {
    throw new Error("BenchRouter inline eval plan is missing plan payload");
  }
  const plan = body.plan;
  if ((plan.action === "run" || plan.action === "decide") && !plan.result_set_id) {
    throw new Error("BenchRouter eval plan is missing result_set_id");
  }
  if (outcome.outcome !== "inline_run") {
    throw new Error("BenchRouter returned plan payload for unexpected outcome: " + outcome.outcome);
  }
  let selectedModel = null;
  if (plan.action === "run") {
    const modelEntries = normalizeModelPlanEntries(plan);
    selectedModel = modelEntries.find((entry) => entry.action === "run") || null;
    if (!selectedModel) {
      throw new Error("BenchRouter eval plan asked CI to run without any runnable model entries");
    }
  }
  await appendEnv({
    BENCHROUTER_PLAN_ACTION: plan.action,
    BENCHROUTER_PLAN_REASON: plan.reason || "",
    BENCHROUTER_RESULT_SET_ID: plan.result_set_id || "",
    BENCHROUTER_ROUTE_ID: plan.route_key || process.env.BENCHROUTER_ROUTE_ID || "",
    BENCHROUTER_PR_HEAD_SHA: request.pull_request_head_sha || "",
    BENCHROUTER_BASE_ROUTE_ID: plan.base_route_key || plan.route_key || process.env.BENCHROUTER_BASE_ROUTE_ID || process.env.BENCHROUTER_ROUTE_ID || "",
    BENCHROUTER_UPLOAD_RESULTS: plan.action === "run" ? "1" : "0",
    BENCHROUTER_MODEL_ID: selectedModel?.model || process.env.BENCHROUTER_MODEL_ID || "",
    BENCHROUTER_MODEL_RUN_ACTION: selectedModel?.action || "",
    BENCHROUTER_MODEL_RUN_ID: selectedModel?.model_run_id || "",
    BENCHROUTER_RESULTS_SUFFIX: selectedModel ? safeResultSuffix(selectedModel.model_run_id) : "",
    // Default semantic-judge model from the server (env BENCHROUTER_DEFAULT_JUDGE_MODEL),
    // carried in the plan response. The workflow_dispatch path gets this via the dispatch
    // input → prepare; the inline pull_request path had no channel for it, so judging
    // degraded ("no judge model configured"). Set it here so model-run scorer judge()
    // calls work on the PR path too. Empty when no default is configured (harness skips).
    BENCHROUTER_JUDGE_MODEL: plan.judge_model || process.env.BENCHROUTER_JUDGE_MODEL || ""
  });
  console.log("BenchRouter: " + (plan.display_name || "Testing route changes"));
  console.log("BenchRouter: starting adaptive evaluation session at tranche " + (plan.tranche || 1));
  await appendStepSummary([
    "## BenchRouter PR plan",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Action | " + plan.action + " |",
    "| Reason | " + (plan.reason || "") + " |",
    "| Route | " + (plan.route_key || "") + " |",
    "| Model | " + (selectedModel?.model || "") + " |",
    "| Model action | " + (selectedModel?.action || "skip") + " |",
    ""
  ]);
}

async function importDefaultBranchConfig(apiUrl) {
  const request = {
    repo_full_name: requiredEnv("BENCHROUTER_REPO_FULL_NAME"),
    config_path: requiredEnv("BENCHROUTER_CONFIG_PATH"),
    kit_version: BENCHROUTER_CI_KIT_VERSION
  };
  await writeTempJson("benchrouter-import-request.json", request);
  const body = await postBenchRouterJson(apiUrl, "/v1/control/import-main", request, "import-main");
  await writeTempJson("benchrouter-import-response.json", body);
  if (!body.ok || !body.imported_default_branch) {
    throw new Error("BenchRouter default-branch import failed");
  }
  // Deploy-skew fallback: older Workers returned carryover_promotions before the
  // merge-adopt response field was renamed to adopted_promotions.
  const adoptedPromotions = Array.isArray(body.adopted_promotions)
    ? body.adopted_promotions
    : (Array.isArray(body.carryover_promotions) ? body.carryover_promotions : []);
  const started = Array.isArray(body.default_branch_result_sets) ? body.default_branch_result_sets.length : 0;
  await appendStepSummary([
    "## BenchRouter default branch import",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Config ref | " + (body.config_ref || "") + " |",
    "| Routes imported | " + (Array.isArray(body.routes) ? body.routes.length : 0) + " |",
    "| Adopted promotions | " + adoptedPromotions.length + " |",
    "| Main-route evals started | " + started + " |",
    ""
  ]);
}

async function reportRouteSnapshot(apiUrl, runtimeEnv = process.env) {
  const configPath = runtimeEnv.BENCHROUTER_CONFIG_PATH || runtimeEnv.BENCHROUTER_DEFAULT_CONFIG_PATH || ".benchrouter/benchrouter.yml";
  const manifest = await readBenchRouterManifest(configPath);
  const repoFullName = manifest.product.repo;
  const token = await benchRouterControlBearer(repoFullName, "route-snapshot", runtimeEnv);
  const source = snapshotSource(runtimeEnv);
  const commitSha = await git(["rev-parse", "HEAD"]);
  const routes = manifest.routes;
  const body = {
    repo_full_name: repoFullName,
    commit_sha: commitSha,
    ref_name: shortRefName(),
    config_path: configPath,
    source,
    pr_number: Number(runtimeEnv.BENCHROUTER_PR_NUMBER || 0) || null,
    kit_version: BENCHROUTER_CI_KIT_VERSION,
    product: {
      slug: manifest.product.slug,
      default_branch: manifest.product.defaultBranch
    },
    routes: await Promise.all(routes.map((route) => buildSnapshotRoute(route, configPath)))
  };
  await writeTempJson("benchrouter-route-snapshot.json", body);
  const response = await fetch(apiUrl + "/v1/route-snapshots", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error("BenchRouter route snapshot failed (" + response.status + "): " + text.slice(0, 500));
  }
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {}
  console.log("BenchRouter route snapshot ok: snapshot_id=" + (parsed.snapshot_id || "?") + " routes=" + routes.length);
}

async function buildSnapshotRoute(route, configPath) {
  if (route.evalMode === "repository_executable") return buildExecutableSnapshotRoute(route, configPath);
  const caseSetSha = await capturedCaseSetSha256({ BENCHROUTER_CASES_PATH: route.casesPath });
  if (!caseSetSha) {
    throw new Error("Could not fingerprint cases for route " + route.routeId + " at " + route.casesPath);
  }
  const scorerSha = await hashFile(route.scorerPath);
  const codeRefHashes = [];
  for (const codeRef of route.codeRefs || []) {
    codeRefHashes.push({ path: codeRef, sha256: await hashFile(codeRef) });
  }
  codeRefHashes.sort((left, right) => left.path.localeCompare(right.path));
  const coveredRefHashes = [...codeRefHashes, { path: route.casesPath, sha256: await hashFile(route.casesPath) }]
    .sort((left, right) => left.path.localeCompare(right.path));
  const inputFp = hashString(canonicalJson({
    route_id: route.routeId,
    result_schema: route.resultSchema,
    workflow: route.workflowPath || null,
    config_path: configPath,
    case_refs: [route.casesPath],
    captured_case_set_sha256: caseSetSha
  }));
  const acceptanceFp = scorerSha;
  const replayContract = await routeReplayContract(route.casesPath);
  return {
    route_id: route.routeId,
    route_slug: route.slug,
    name: route.name,
    best_model: route.bestModel,
    eval_fingerprint: hashString(inputFp + ":" + acceptanceFp),
    input_fingerprint: inputFp,
    acceptance_fingerprint: acceptanceFp,
    config_sha256: await hashFile(configPath),
    scorer_sha256: scorerSha,
    case_set_sha256: caseSetSha,
    code_refs_sha256: hashString(canonicalJson(codeRefHashes)),
    covered_refs_sha256: hashString(canonicalJson(coveredRefHashes)),
    case_count: await caseCount(route.casesPath),
    eval_command: route.evalCommand,
    result_schema: route.resultSchema,
    scorer_path: route.scorerPath,
    cases_path: route.casesPath,
    workflow_path: route.workflowPath,
    code_refs: route.codeRefs || [],
    code_ref_hashes: codeRefHashes,
    api_family: replayContract.apiFamily,
    required_parameters: replayContract.requiredParameters,
    eval_pack: route.evalPack,
    metadata: {
      eval_archetype: route.evalArchetype || "",
      base_url_env: route.baseUrlEnv || "",
      provider_id: route.providerId || "",
      provider_ref: route.providerRef || "",
      observed_model: ""
    }
  };
}

async function buildExecutableSnapshotRoute(route, configPath) {
  const executable = route.executable;
  const inputHashes = await hashDeclaredRefs(executable.inputRefs);
  const acceptanceHashes = await hashDeclaredRefs(executable.acceptanceRefs);
  const lockfileSha = await hashFile(executable.lockfile);
  const codeRefHashes = await hashDeclaredRefs(route.codeRefs || []);
  const executionContract = { mode: route.evalMode, argv: executable.argv, runtime: executable.runtime, runtime_version: executable.runtimeVersion, lockfile: executable.lockfile, lockfile_sha256: lockfileSha, result_schema: route.resultSchema, result_path: executable.resultPath, primary_metric: executable.primaryMetric, max_model_calls: executable.maxModelCalls, max_cost_usd: executable.maxCostUsd, max_cost_per_call_usd: executable.maxCostPerCallUsd, timeout_minutes: executable.timeoutMinutes, secret_env: executable.secretEnv };
  const inputFp = hashString(canonicalJson({ route_id: route.routeId, execution: executionContract, input_refs: inputHashes, code_refs: codeRefHashes }));
  const acceptanceFp = hashString(canonicalJson({ primary_metric: executable.primaryMetric, acceptance_refs: acceptanceHashes }));
  const caseSetSha = hashString(canonicalJson(inputHashes));
  const scorerSha = hashString(canonicalJson(acceptanceHashes));
  return { route_id: route.routeId, route_slug: route.slug, name: route.name, best_model: route.bestModel, eval_fingerprint: hashString(inputFp + ":" + acceptanceFp), input_fingerprint: inputFp, acceptance_fingerprint: acceptanceFp, config_sha256: await hashFile(configPath), scorer_sha256: scorerSha, case_set_sha256: caseSetSha, code_refs_sha256: hashString(canonicalJson(codeRefHashes)), covered_refs_sha256: hashString(canonicalJson([...inputHashes, ...acceptanceHashes, ...codeRefHashes])), case_count: 0, eval_command: route.evalCommand, result_schema: route.resultSchema, scorer_path: executable.acceptanceRefs[0], cases_path: executable.inputRefs[0], workflow_path: route.workflowPath, code_refs: route.codeRefs || [], code_ref_hashes: codeRefHashes, api_family: null, required_parameters: null, eval_pack: route.evalPack, metadata: { eval_archetype: route.evalArchetype || "", base_url_env: route.baseUrlEnv || "", provider_id: route.providerId || "", provider_ref: route.providerRef || "", observed_model: "" } };
}

async function hashDeclaredRefs(refs) {
  const hashes = [];
  for (const ref of refs) hashes.push({ path: ref, sha256: await hashFile(ref) });
  return hashes.sort((left, right) => left.path.localeCompare(right.path));
}

function shortRefName(runtimeEnv = process.env) {
  const raw = runtimeEnv.BENCHROUTER_REF_NAME || runtimeEnv.GITHUB_HEAD_REF || runtimeEnv.GITHUB_REF || runtimeEnv.GITHUB_REF_NAME || "";
  if (!raw) return null;
  return String(raw)
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "")
    .replace(/^refs\/pull\//, "");
}

function snapshotSource(runtimeEnv = process.env) {
  const source = runtimeEnv.BENCHROUTER_SNAPSHOT_SOURCE || runtimeEnv.GITHUB_EVENT_NAME || "";
  return ["setup", "pull_request", "push", "workflow_dispatch"].includes(source) ? source : "workflow_dispatch";
}

async function caseCount(casesPath) {
  const parsed = JSON.parse(await readFile(casesPath, "utf8"));
  return Array.isArray(parsed) ? parsed.length : 0;
}

async function routeReplayContract(casesPath) {
  const parsed = JSON.parse(await readFile(casesPath, "utf8"));
  if (!Array.isArray(parsed)) return { apiFamily: null, requiredParameters: null };
  const families = new Set();
  const required = new Set();
  for (const testCase of parsed) {
    if (!testCase || typeof testCase !== "object") continue;
    const endpoint = typeof testCase.endpoint === "string" && testCase.endpoint.length > 0
      ? testCase.endpoint.split("?")[0].replace(/\/+$/, "")
      : "/v1/chat/completions";
    const family = endpoint.endsWith("/chat/completions")
      ? "chat_completions"
      : endpoint.endsWith("/responses") ? "responses" : null;
    if (!family) return { apiFamily: null, requiredParameters: null };
    families.add(family);
    const body = testCase.input && typeof testCase.input === "object" && !Array.isArray(testCase.input)
      ? { ...testCase.input }
      : Array.isArray(testCase.messages) ? { messages: testCase.messages } : null;
    if (!body) continue;
    body.model = "route";
    if (body.temperature === undefined) body.temperature = 0;
    const core = family === "chat_completions" ? new Set(["model", "messages", "stream"]) : new Set(["model", "input", "stream"]);
    for (const key of Object.keys(body)) {
      if (core.has(key)) continue;
      if (key === "temperature" && body[key] === 0) continue;
      required.add(key);
    }
  }
  if (families.size === 0) return { apiFamily: null, requiredParameters: null };
  return {
    apiFamily: families.size === 1 ? Array.from(families)[0] : "mixed",
    requiredParameters: Array.from(required).sort()
  };
}

function safeResultSuffix(value) {
  return String(value || "round").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(name + " is required");
  }
  return value;
}

async function repoOidcAudience(repoFullName, action) {
  const base = process.env.BENCHROUTER_OIDC_AUDIENCE || "benchrouter";
  return base + ":repo:" + repoFullName + ":" + action;
}

async function benchRouterControlBearer(repoFullName, oidcAction, runtimeEnv = process.env) {
  if (GITHUB_OIDC_REQUEST_ENV.requestUrl && GITHUB_OIDC_REQUEST_ENV.requestToken) {
    return requestGitHubOidcToken(await repoOidcAudience(repoFullName, oidcAction));
  }
  const setupToken = runtimeEnv.BENCHROUTER_SETUP_TOKEN || runtimeEnv.BENCHROUTER_TOKEN;
  if (setupToken) {
    return setupToken;
  }
  throw new Error("BenchRouter control auth requires GitHub Actions OIDC or BENCHROUTER_SETUP_TOKEN");
}

async function postBenchRouterJson(apiUrl, path, body, oidcAction) {
  const repoFullName = requiredEnv("BENCHROUTER_REPO_FULL_NAME");
  const token = await benchRouterControlBearer(repoFullName, oidcAction);
  const response = await fetch(apiUrl + path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error("BenchRouter request failed (" + response.status + "): " + text.slice(0, 500));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("BenchRouter response was not valid JSON: " + text.slice(0, 500));
  }
}

async function appendEnv(values) {
  const envPath = requiredEnv("GITHUB_ENV");
  const lines = Object.entries(values).map(([name, value]) => name + "=" + String(value ?? ""));
  await appendFile(envPath, lines.join("\n") + "\n");
}

async function appendStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
}

async function writeTempJson(fileName, value) {
  if (!process.env.RUNNER_TEMP) {
    return;
  }
  await writeFile(process.env.RUNNER_TEMP + "/" + fileName, JSON.stringify(value));
}


// CI executes ONLY the kit's own replay harness, by FIXED path. The command is
// built by the kit (not read from any customer-mutable input), so this guard is
// a tripwire: if a refactor ever reintroduces a customer-controlled command it
// fails closed here. Customer code/tests run locally during setup/case
// creation, never in CI.
function assertReplayOnlyCommand(command) {
  if (String(command || "").trim() !== REPLAY_HARNESS_COMMAND) {
    throw new Error(
      "BenchRouter CI runs only the replay harness (" + REPLAY_HARNESS_COMMAND + "); customer code/tests run locally during setup/case creation, never in CI. Refusing to execute: " + command
    );
  }
}

async function runModel(runtimeEnv) {
  const result = await runModelMeasured(runtimeEnv);
  return result.code;
}

async function runModelPack(apiUrl) {
  const members = normalizeModelPlanEntries({ models: JSON.parse(requiredEnv("BENCHROUTER_PACK_MEMBERS_JSON")) });
  await runModelPackMembers(apiUrl, members, process.env);
}

async function runAdaptiveSession(apiUrl) {
  const responsePath = requiredEnv("RUNNER_TEMP") + "/benchrouter-eval-plan.json";
  const initial = JSON.parse(await readFile(responsePath, "utf8"));
  if (!initial.plan || initial.outcome?.outcome !== "inline_run") {
    throw new Error("BenchRouter PR session is missing its inline execution plan");
  }
  let current = { state: "run", result_set_id: initial.plan.result_set_id, tranche: initial.plan.tranche || 1, models: initial.plan.models, progress: null };
  const displayName = initial.plan.display_name || ("Testing route " + requiredEnv("BENCHROUTER_ROUTE_ID"));
  let completedInSession = 0;
  let finalizePolls = 0;
  while (current.state === "run") {
    const members = normalizeModelPlanEntries({ models: current.models });
    if (members.length === 0) throw new Error("BenchRouter session returned an empty runnable tranche");
    const packs = [...new Map(members.map((member) => [member.pack_id, members.filter((candidate) => candidate.pack_id === member.pack_id)])).values()];
    console.log("::group::Tranche " + current.tranche + " · " + displayName);
    console.log("Testing " + members.length + " model" + (members.length === 1 ? "" : "s") + " in " + packs.length + " pack" + (packs.length === 1 ? "" : "s"));
    const results = await Promise.all(packs.map((pack) => runModelPackMembers(apiUrl, pack, {
      ...process.env,
      BENCHROUTER_RESULT_SET_ID: current.result_set_id
    })));
    const completed = results.reduce((sum, result) => sum + result.completed, 0);
    const failed = results.reduce((sum, result) => sum + result.failed, 0);
    completedInSession += completed;
    console.log("Tranche " + current.tranche + " complete: " + completed + " models checked, " + failed + " infrastructure failures");
    console.log("::endgroup::");
    current = await nextSessionPlan(apiUrl);
    while (current.state === "waiting") {
      finalizePolls += 1;
      if (finalizePolls > 150) throw new Error("BenchRouter timed out while finalizing the current PPF");
      if (finalizePolls === 1 || finalizePolls % 15 === 0) console.log("BenchRouter: finalizing the current PPF before the next tranche");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      current = await nextSessionPlan(apiUrl);
    }
    finalizePolls = 0;
    const progress = current.progress || {};
    console.log("BenchRouter progress: " + (progress.models_completed ?? completedInSession) + " models complete across " + (progress.tranches_completed ?? current.tranche) + " tranches");
  }
  console.log("BenchRouter complete: selected " + (current.selected_model || "the current best model") + " for " + requiredEnv("BENCHROUTER_ROUTE_ID"));
  await appendStepSummary([
    "## BenchRouter route test complete",
    "",
    "**Why this ran:** " + displayName + ".",
    "",
    "| Result | Value |",
    "| --- | --- |",
    "| Route | " + requiredEnv("BENCHROUTER_ROUTE_ID") + " |",
    "| Selected model | " + (current.selected_model || "-") + " |",
    "| Models checked | " + (current.progress?.models_completed ?? completedInSession) + " |",
    "| Tranches | " + (current.progress?.tranches_completed ?? "-") + " |",
    ""
  ]);
}

async function nextSessionPlan(apiUrl) {
  const body = await postBenchRouterJson(apiUrl, "/v1/control/eval-session/next", {
    repo_full_name: requiredEnv("BENCHROUTER_REPO_FULL_NAME"),
    route_id: requiredEnv("BENCHROUTER_ROUTE_ID"),
    pr_head_sha: requiredEnv("BENCHROUTER_PR_HEAD_SHA")
  }, "eval-session");
  if (!body.ok || !["run", "waiting", "complete"].includes(body.state)) {
    throw new Error("BenchRouter returned an invalid adaptive session response");
  }
  return body;
}

async function runModelPackMembers(apiUrl, members, baseEnv) {
  let completed = 0;
  let failed = 0;
  for (const member of members) {
    if (member.action !== "run") continue;
    const runtimeEnv = {
      ...baseEnv,
      BENCHROUTER_MODEL_ID: member.model,
      BENCHROUTER_MODEL_RUN_ID: member.model_run_id,
      BENCHROUTER_MODEL_RUN_ACTION: member.action,
      BENCHROUTER_RESULTS_SUFFIX: safeResultSuffix(member.model_run_id),
      BENCHROUTER_UPLOAD_RESULTS: "1"
    };
    let session = null;
    try {
      console.log("BenchRouter model started: " + member.model);
      session = await exchangeUploadToken(apiUrl, member.model_run_id, await requestGitHubOidcToken(modelRunAudience(member.model_run_id)));
      runtimeEnv.BENCHROUTER_UPLOAD_TOKEN = session.uploadToken;
      runtimeEnv.BENCHROUTER_EVAL_CALL_TOKEN_MODEL = session.evalCallTokens.model || "";
      runtimeEnv.BENCHROUTER_EVAL_CALL_TOKEN_JUDGE = session.evalCallTokens.judge || "";
      const code = await runModel(runtimeEnv);
      if (code !== 0) throw new Error("model replay failed with exit code " + code);
      await uploadModelResults(apiUrl, runtimeEnv);
      completed += 1;
      console.log("BenchRouter model complete: " + member.model);
    } catch (error) {
      failed += 1;
      console.error("BenchRouter pack member failed", member.model_run_id, error);
      try {
        runtimeEnv.BENCHROUTER_FAILED_STEP = session ? "run-or-upload" : "start";
        runtimeEnv.BENCHROUTER_GITHUB_CONCLUSION = "failure";
        const failureOidc = session?.uploadToken ? "" : await requestGitHubOidcToken(modelRunAudience(member.model_run_id));
        await notifyFailure(apiUrl, member.model_run_id, session?.uploadToken || "", failureOidc, false, runtimeEnv);
      } catch (notifyError) {
        console.error("BenchRouter pack member failure notification failed", member.model_run_id, notifyError);
      }
    }
  }
  return { completed, failed };
}

  // Declared-case replay: the harness (the kit's own benchrouter:eval script)
  // replays the declared cases against the forced model, runs the extracted
  // scorer, and writes one model-run results JSONL file with model_call evidence.
  // A scorer REJECT is eval DATA (a pass:false row, uploaded), NOT a step
  // failure; the harness exits non-zero only on a genuine fault (HTTP/transport,
  // missing model_call_id, scorer load/sandbox failure). No customer code, no deps, no sidecar in CI - cases were produced
  // locally.
  // FIXED, kit-built command - BENCHROUTER_EVAL_COMMAND is NOT consulted for
  // execution (it survives only as a fingerprint identity value). The customer's
  // tests (eval_pack.capture_command) run LOCALLY during setup/case creation,
  // never in CI - input_fp excludes the command + code_refs precisely because no
  // customer code runs here.
async function runModelMeasured(runtimeEnv) {
  requiredString(runtimeEnv.BENCHROUTER_MODEL_ID || runtimeEnv.BENCHROUTER_FORCE_MODEL, "BENCHROUTER_MODEL_ID");
  if (runtimeEnv.BENCHROUTER_EVAL_MODE === "repository_executable") {
    const route = await runtimeRoute(runtimeEnv);
    const startedAt = Date.now();
    const code = await runArgv(route.executable.argv, executableChildEnv(route, runtimeEnv), route.executable.timeoutMinutes * 60 * 1000);
    return { code, elapsedSeconds: Math.max(1, Math.ceil((Date.now() - startedAt) / 1000)) };
  }
  const command = REPLAY_HARNESS_COMMAND;
  assertReplayOnlyCommand(command);
  const startedAt = Date.now();
  const code = await runShell(command, {
      ...runtimeEnv,
      BENCHROUTER_FORCE_MODEL: runtimeEnv.BENCHROUTER_FORCE_MODEL || runtimeEnv.BENCHROUTER_MODEL_ID,
      BENCHROUTER_RESULTS_SUFFIX: runtimeEnv.BENCHROUTER_RESULTS_SUFFIX || safeResultSuffix(runtimeEnv.BENCHROUTER_MODEL_RUN_ID || runtimeEnv.BENCHROUTER_MODEL_ID)
    });
  return { code, elapsedSeconds: Math.max(1, Math.ceil((Date.now() - startedAt) / 1000)) };
}

async function runtimeRoute(runtimeEnv) {
  const manifest = await readBenchRouterManifest(requiredString(runtimeEnv.BENCHROUTER_CONFIG_PATH, "BENCHROUTER_CONFIG_PATH"));
  const routeId = requiredString(runtimeEnv.BENCHROUTER_BASE_ROUTE_ID || runtimeEnv.BENCHROUTER_ROUTE_ID, "BENCHROUTER_ROUTE_ID");
  const route = manifest.routes.find((entry) => entry.routeId === routeId);
  if (!route) throw new Error("Route " + routeId + " is not declared in the manifest");
  return route;
}

async function installExecutableDependencies() {
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const route = await runtimeRoute(process.env);
  if (route.evalMode !== "repository_executable") return;
  const argv = route.executable.runtime === "bun" ? ["bun", "install", "--frozen-lockfile", "--ignore-scripts"] : ["npm", "ci", "--ignore-scripts"];
  const code = await runArgv(argv, executableChildEnv(route, process.env, false), route.executable.timeoutMinutes * 60 * 1000);
  if (code !== 0) throw new Error("BenchRouter executable dependency install failed with exit code " + code);
}

function executableChildEnv(route, runtimeEnv, includeSecrets = true) {
  const allowed = new Set(["PATH", "HOME", "TMPDIR", "CI", "LANG", "LC_ALL", ...(includeSecrets ? route.executable.secretEnv : [])]);
  const env = {};
  for (const [name, value] of Object.entries(runtimeEnv)) if (allowed.has(name) && typeof value === "string") env[name] = value;
  env.BENCHROUTER_ROUTE_ID = runtimeEnv.BENCHROUTER_ROUTE_ID;
  env.BENCHROUTER_RESULT_SET_ID = runtimeEnv.BENCHROUTER_RESULT_SET_ID;
  env.BENCHROUTER_MODEL_RUN_ID = runtimeEnv.BENCHROUTER_MODEL_RUN_ID;
  env.BENCHROUTER_FORCE_MODEL = runtimeEnv.BENCHROUTER_MODEL_ID;
  env.BENCHROUTER_EVAL_BASE_URL = String(runtimeEnv.BENCHROUTER_API_URL || "");
  env.BENCHROUTER_EVAL_HEADERS_JSON = JSON.stringify({ "x-benchrouter-result-set-id": runtimeEnv.BENCHROUTER_RESULT_SET_ID, "x-benchrouter-model-run-id": runtimeEnv.BENCHROUTER_MODEL_RUN_ID, "x-benchrouter-eval-call-token": runtimeEnv.BENCHROUTER_EVAL_CALL_TOKEN_MODEL, "x-benchrouter-force-model": runtimeEnv.BENCHROUTER_MODEL_ID });
  if (route.baseUrlEnv) env[route.baseUrlEnv] = env.BENCHROUTER_EVAL_BASE_URL;
  return env;
}

async function runArgv(argv, env, timeoutMs) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("Executable argv is empty");
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: "inherit", env });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); console.error(error); resolve(1); });
    child.on("exit", (code, signal) => { clearTimeout(timer); if (signal) console.error("BenchRouter executable terminated by signal " + signal); resolve(signal ? 1 : code ?? 1); });
  });
}

async function runShell(command, env) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env
    });
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error("BenchRouter eval command terminated by signal " + signal);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function uploadModelResults(apiUrl, runtimeEnv = process.env) {
  if (runtimeEnv.BENCHROUTER_UPLOAD_RESULTS !== "1") {
    return;
  }

  const resultSetId = requiredString(runtimeEnv.BENCHROUTER_RESULT_SET_ID, "BENCHROUTER_RESULT_SET_ID");
  const modelRunId = requiredString(runtimeEnv.BENCHROUTER_MODEL_RUN_ID, "BENCHROUTER_MODEL_RUN_ID");
  const action = requiredString(runtimeEnv.BENCHROUTER_MODEL_RUN_ACTION, "BENCHROUTER_MODEL_RUN_ACTION");
  if (action !== "run") {
    return;
  }
  const uploadToken =
    runtimeEnv.BENCHROUTER_UPLOAD_TOKEN ||
    (await exchangeUploadToken(apiUrl, modelRunId, await requestGitHubOidcToken(modelRunAudience(modelRunId)))).uploadToken;
  if (runtimeEnv.BENCHROUTER_EVAL_MODE === "repository_executable") {
    const route = await runtimeRoute(runtimeEnv);
    await uploadExecutableResults(apiUrl, runtimeEnv, route, uploadToken, resultSetId, modelRunId);
    return;
  }
  const filePath = resultFilePath(runtimeEnv);
  const rows = await readJsonl(filePath);
  assertNoTechnicalFailures(rows);
  const normalized = normalizeModelRows(rows);
  assertModelUploadEvidence(normalized);
  const fingerprint = await buildFingerprint(normalized, runtimeEnv);
  await writeFile(fingerprintFilePath(runtimeEnv), JSON.stringify(fingerprint, null, 2) + "\n");

  const response = await fetch(apiUrl + "/v1/eval-model-runs/" + encodeURIComponent(modelRunId) + "/results", {
      method: "POST",
      headers: {
        authorization: "Bearer " + uploadToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        result_set_id: resultSetId,
        action: "run",
        fingerprint,
        results: normalized
      })
    });
  if (!response.ok) {
    const responseText = await response.text();
    let responseCode = "upload_rejected";
    try {
      const parsed = JSON.parse(responseText);
      const candidate = parsed && typeof parsed === "object" ? (parsed.code || parsed.error?.code) : null;
      if (typeof candidate === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)) responseCode = candidate;
    } catch {}
    await writeFile(uploadErrorFilePath(runtimeEnv), JSON.stringify({ http_status: response.status, error_code: responseCode, message: "upload rejected (HTTP " + response.status + ")" }) + "\n");
    try {
      const oidcToken = await requestGitHubOidcToken(modelRunAudience(modelRunId));
      await notifyFailure(apiUrl, modelRunId, uploadToken, oidcToken, false, runtimeEnv);
    } catch (notifyError) {
      console.error("BenchRouter direct failure notification failed; workflow fail step will retry", notifyError);
    }
    throw new Error("BenchRouter model result upload failed (" + response.status + ")");
  }
  await writeModelStepSummary(normalized, fingerprint);
}

async function uploadExecutableResults(apiUrl, runtimeEnv, route, uploadToken, resultSetId, modelRunId) {
  const receipt = JSON.parse(await readFile(route.executable.resultPath, "utf8"));
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Executable result receipt must be an object");
  const primary = receipt.primary_metric;
  if (!primary || primary.name !== route.executable.primaryMetric || typeof primary.score !== "number" || !Number.isFinite(primary.score) || primary.score < 0 || primary.score > 1) throw new Error("Executable result receipt has an invalid primary metric");
  const ids = Array.isArray(receipt.model_call_ids) ? receipt.model_call_ids.filter((value) => typeof value === "string" && value.length > 0) : [];
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("Executable result receipt must include unique model_call_ids");
  const observations = Array.isArray(receipt.observations) ? receipt.observations : [];
  const results = observations.map((entry, index) => ({ case_id: String(entry.id || index + 1), case_version: String(entry.version || "1"), critical: entry.critical === true, model: runtimeEnv.BENCHROUTER_MODEL_ID, selected_model: runtimeEnv.BENCHROUTER_MODEL_ID, model_call_ids: [], pass: entry.pass === true, score: typeof entry.score === "number" ? entry.score : entry.pass === true ? 1 : 0 }));
  const fingerprint = await buildFingerprint(results, runtimeEnv);
  const response = await fetch(apiUrl + "/v1/eval-model-runs/" + encodeURIComponent(modelRunId) + "/results", { method: "POST", headers: { authorization: "Bearer " + uploadToken, "content-type": "application/json" }, body: JSON.stringify({ result_set_id: resultSetId, action: "run", fingerprint, model_call_ids: ids, quality: { primary_metric: primary, metrics: receipt.metrics || {} }, results }) });
  if (!response.ok) throw new Error("BenchRouter executable result upload failed (" + response.status + " ): " + (await response.text()).slice(0, 500));
}

function resultFilePath(runtimeEnv) {
  const suffix = safeResultSuffix(runtimeEnv.BENCHROUTER_RESULTS_SUFFIX || runtimeEnv.BENCHROUTER_MODEL_RUN_ID || runtimeEnv.BENCHROUTER_MODEL_ID || "model");
  return ".benchrouter/results." + suffix + ".jsonl";
}

function fingerprintFilePath(runtimeEnv) {
  const suffix = safeResultSuffix(runtimeEnv.BENCHROUTER_RESULTS_SUFFIX || runtimeEnv.BENCHROUTER_MODEL_RUN_ID || runtimeEnv.BENCHROUTER_MODEL_ID || "model");
  return ".benchrouter/fingerprint." + suffix + ".json";
}

function runErrorFilePath(runtimeEnv) {
  const suffix = safeResultSuffix(runtimeEnv.BENCHROUTER_RESULTS_SUFFIX || runtimeEnv.BENCHROUTER_MODEL_RUN_ID || runtimeEnv.BENCHROUTER_MODEL_ID || "model");
  return ".benchrouter/run-error." + suffix + ".json";
}

function uploadErrorFilePath(runtimeEnv) {
  const suffix = safeResultSuffix(runtimeEnv.BENCHROUTER_RESULTS_SUFFIX || runtimeEnv.BENCHROUTER_MODEL_RUN_ID || runtimeEnv.BENCHROUTER_MODEL_ID || "model");
  return ".benchrouter/upload-error." + suffix + ".json";
}

async function buildFingerprint(results, runtimeEnv = process.env) {
  const configPath = requiredString(runtimeEnv.BENCHROUTER_CONFIG_PATH, "BENCHROUTER_CONFIG_PATH");
  const evalCommand = requiredString(runtimeEnv.BENCHROUTER_EVAL_COMMAND, "BENCHROUTER_EVAL_COMMAND");
  const resultSchema = requiredString(runtimeEnv.BENCHROUTER_RESULT_SCHEMA, "BENCHROUTER_RESULT_SCHEMA");
  if (runtimeEnv.BENCHROUTER_EVAL_MODE === "repository_executable") {
    const route = await runtimeRoute(runtimeEnv);
    return { commit_sha: await git(["rev-parse", "HEAD"]), config_path: configPath, config_sha256: await hashFile(configPath), eval_command: evalCommand, result_schema: resultSchema, execution_mode: route.evalMode, lockfile_sha256: await hashFile(route.executable.lockfile), input_refs: await hashDeclaredRefs(route.executable.inputRefs), acceptance_refs: await hashDeclaredRefs(route.executable.acceptanceRefs), runner: { benchrouter_ci_kit_version: BENCHROUTER_CI_KIT_VERSION, github_job: process.env.GITHUB_JOB || "", runner_os: process.env.RUNNER_OS || "", node: process.version } };
  }
  const scorerPath = requiredString(runtimeEnv.BENCHROUTER_SCORER_PATH, "BENCHROUTER_SCORER_PATH");
  return {
    commit_sha: await git(["rev-parse", "HEAD"]),
    config_path: configPath,
    config_sha256: await hashFile(configPath),
    eval_command: evalCommand,
    result_schema: resultSchema,
    case_set_sha256: caseSetHash(results),
    captured_case_set_sha256: await capturedCaseSetSha256(runtimeEnv),
    scorer_sha256: await hashFile(scorerPath),
    runner: {
      benchrouter_ci_kit_version: BENCHROUTER_CI_KIT_VERSION,
      github_job: process.env.GITHUB_JOB || "",
      runner_os: process.env.RUNNER_OS || "",
      node: process.version
    }
  };
}

async function requestGitHubOidcToken(audience) {
  const { requestUrl, requestToken } = GITHUB_OIDC_REQUEST_ENV;
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub OIDC request environment is unavailable");
  }

  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: {
      authorization: "Bearer " + requestToken,
      accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error("GitHub OIDC token request failed (" + response.status + ")");
  }
  const data = await response.json();
  if (!data.value) {
    throw new Error("GitHub OIDC response did not include a token value");
  }
  return data.value;
}

async function exchangeUploadToken(apiUrl, modelRunId, oidcToken) {
  const response = await fetch(apiUrl + "/v1/eval-model-runs/" + encodeURIComponent(modelRunId) + "/upload-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oidc_token: oidcToken, kit_version: BENCHROUTER_CI_KIT_VERSION, dispatch_attempt_id: process.env.BENCHROUTER_DISPATCH_ATTEMPT_ID || undefined })
  });
  if (!response.ok) {
    throw new Error("BenchRouter upload-token exchange failed (" + response.status + "): " + (await response.text()).slice(0, 500));
  }
  const data = await response.json();
  if (!data.upload_token) {
    throw new Error("BenchRouter upload-token response did not include upload_token");
  }
  const tokens = data.eval_call_tokens && typeof data.eval_call_tokens === "object" ? data.eval_call_tokens : {};
  return {
    uploadToken: data.upload_token,
    evalCallTokens: {
      model: typeof tokens.model === "string" ? tokens.model : "",
      judge: typeof tokens.judge === "string" ? tokens.judge : ""
    }
  };
}

async function notifyFailure(apiUrl, modelRunId, uploadToken, oidcToken, timedOut, runtimeEnv = process.env) {
  const diagnostic = await buildFailureDiagnostic(timedOut, runtimeEnv);
  const headers = { "content-type": "application/json", "x-benchrouter-github-oidc": oidcToken };
  if (uploadToken) headers.authorization = "Bearer " + uploadToken;
  const response = await fetch(apiUrl + "/v1/eval-model-runs/" + encodeURIComponent(modelRunId) + "/failure", {
    method: "POST",
    headers,
    body: JSON.stringify({
      diagnostic
    })
  });
  if (!response.ok) {
    throw new Error("BenchRouter failure notification failed (" + response.status + "): " + (await response.text()).slice(0, 500));
  }
}

async function buildFailureDiagnostic(timedOut, runtimeEnv) {
  let rows = [];
  try { rows = await readJsonl(resultFilePath(runtimeEnv)); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
  const runError = await readJsonIfPresent(runErrorFilePath(runtimeEnv));
  const uploadError = await readJsonIfPresent(uploadErrorFilePath(runtimeEnv));
  const succeeded = [];
  const failed = [];
  for (const row of rows.slice(0, 256)) {
    const ids = Array.isArray(row.model_call_ids) ? row.model_call_ids.filter((id) => typeof id === "string" && id.length > 0).slice(0, 16) : [];
    if (!row.technical_failure && ids.length > 0) {
      succeeded.push({ case_id: boundedId(row.case_id), model_call_ids: ids.map(boundedId) });
      continue;
    }
    const failure = row.technical_failure && typeof row.technical_failure === "object" ? row.technical_failure : {};
    failed.push(failedCase(boundedId(row.case_id), failure, ids[0] || null, row.latency_ms));
  }
  if (rows.length === 0 && runError) failed.push(failedCase("__harness__", runError, null, null));
  const conclusion = String(runtimeEnv.BENCHROUTER_GITHUB_CONCLUSION || (timedOut ? "timed_out" : "failure")).slice(0, 64);
  const failedStep = String(runtimeEnv.BENCHROUTER_FAILED_STEP || (timedOut ? "timeout" : "workflow")).slice(0, 64);
  const reasonCode = conclusion === "cancelled" ? FAILURE_REASON_CODES.cancelled
    : uploadError ? FAILURE_REASON_CODES.uploadRejected
    : failed.length > 0 ? FAILURE_REASON_CODES.caseFailures
    : FAILURE_REASON_CODES.workflowStepFailed;
  const planned = rows.length > 0 ? rows.length : failed.length;
  return { v: 1, source: "workflow_fail_step", reason_code: reasonCode, failed_step: failedStep, github_conclusion: conclusion,
    cases: planned > 0 ? { planned, succeeded, failed } : null };
}

function failedCase(caseId, failure, modelCallId, latencyMs) {
  const stage = FAILURE_STAGES.has(failure.stage) ? failure.stage : "harness";
  const errorCode = CASE_ERROR_CODES.has(failure.error_code) ? failure.error_code : "unknown";
  return { case_id: caseId, stage, error_code: errorCode, cause_code: safeCode(failure.cause_code), cause_name: safeCode(failure.cause_name),
    message: cleanDiagnosticMessage(failure.message), model_call_id: modelCallId ? boundedId(modelCallId) : null,
    latency_ms: Number.isInteger(latencyMs) && latencyMs >= 0 ? latencyMs : null };
}

function boundedId(value) { return String(value || "unknown").replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 200) || "unknown"; }
function safeCode(value) { return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null; }
function cleanDiagnosticMessage(value) { return String(value || "evaluation infrastructure failed").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, 500) || "evaluation infrastructure failed"; }
async function readJsonIfPresent(filePath) { try { return JSON.parse(await readFile(filePath, "utf8")); } catch (error) { if (error && error.code === "ENOENT") return null; throw error; } }

function normalizeModelRows(rows) {
  return rows.map((row) => ({
    case_id: String(row.case_id || ""),
    case_version: String(row.case_version || ""),
    critical: row.critical === true,
    model: String(row.model || ""),
    selected_model: typeof row.selected_model === "string" ? row.selected_model : null,
    model_call_ids: Array.isArray(row.model_call_ids) ? row.model_call_ids.filter((value) => typeof value === "string" && value.length > 0) : [],
    pass: row.pass === true,
    score: typeof row.score === "number" ? row.score : row.pass === true ? 1 : 0,
    cost_usd: typeof row.cost_usd === "number" ? row.cost_usd : null,
    latency_ms: typeof row.latency_ms === "number" ? row.latency_ms : null,
    error: typeof row.error === "string" ? row.error : null,
    outcome_code: row.outcome_code === "response_format_unhonored" ? row.outcome_code : null,
    // Raw replay evidence for free re-judge (§7.2/§7.3) — uploaded so the server
    // can re-run a changed scorer over stored outputs without a model call.
    raw_output: typeof row.raw_output === "string" ? row.raw_output : null,
    reference_output: typeof row.reference_output === "string" ? row.reference_output : null,
    judge_cost_usd: typeof row.judge_cost_usd === "number" ? row.judge_cost_usd : null
  }));
}

function assertNoTechnicalFailures(rows) {
  const failed = rows.filter((row) => row && typeof row === "object" && row.technical_failure);
  if (failed.length > 0) {
    throw new Error("BenchRouter model results contain infrastructure failures and cannot be accepted");
  }
}

function assertModelUploadEvidence(rows) {
  const missing = rows
    .filter((row) => !Array.isArray(row.model_call_ids) || row.model_call_ids.length === 0)
    .map((row) => row.case_id + (row.error ? " (" + row.error + ")" : ""));
  if (missing.length > 0) {
    throw new Error("BenchRouter model results are missing model_call_ids; requests must pass through BenchRouter before upload. Missing: " + missing.slice(0, 10).join(", "));
  }
}

async function writeModelStepSummary(rows, fingerprint) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const total = rows.length;
  const passes = rows.filter((row) => row.pass === true).length;
  const cost = rows.reduce((sum, row) => sum + (typeof row.cost_usd === "number" ? row.cost_usd : 0), 0);
  const first = rows[0];
  const lines = [
    "",
    "## BenchRouter model result",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    "| Model | " + markdownCell(first?.model || "") + " |",
    "| Cases | " + total + " |",
    "| Pass | " + passes + "/" + total + " |",
    "| Cost | " + formatUsd(cost) + " |",
    "| Commit | " + markdownCell(String(fingerprint.commit_sha || "").slice(0, 12)) + " |",
    ""
  ];
  await appendFile(summaryPath, lines.join("\n"));
}

function formatUsd(value) {
  return typeof value === "number" ? "$" + value.toFixed(4) : "-";
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 240);
}

function caseSetHash(results) {
  return hashString(JSON.stringify(results.map((row) => ({
    case_id: row.case_id,
    case_version: row.case_version,
    critical: row.critical === true
  })).sort((left, right) => left.case_id.localeCompare(right.case_id))));
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function hashFile(filePath) {
  // Hash the file's RAW BYTES (read as a Buffer, no encoding) — NOT
  // readFile(...,'utf8')→hash-text, which round-trips through UTF-8 and would
  // diverge from the server on non-ASCII or non-UTF-8 content. GitHub serves the
  // server the same on-disk bytes (base64), so both sides hash identical bytes.
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function hashString(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Canonical JSON identical to the server's src/shared/parsing.ts canonicalJson
// (recursively sorted object keys, array order preserved) so a hash computed here
// matches a hash computed server-side over the same value.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

// The CONTENT hash of the captured case files — the IDENTICAL representation the
// server planner folds into input_fp and stores as planned_case_set_sha256
// (sha256(canonicalJson([{ path, sha256(content) } ...]))). The upload identity
// binding compares this against the planned value, so it MUST match byte-for-byte.
// The v2 kit uses a single captured-cases file (BENCHROUTER_CASES_PATH = the
// route's case_ref); returns null only if the cases path is unset/unreadable.
async function capturedCaseSetSha256(runtimeEnv = process.env) {
  const casesPath = runtimeEnv.BENCHROUTER_CASES_PATH || "";
  if (!casesPath) {
    return null;
  }
  try {
    const entry = { path: casesPath, sha256: await hashFile(casesPath) };
    return hashString(canonicalJson([entry]));
  } catch {
    return null;
  }
}

async function git(args) {
  const result = await execFileAsync("git", args);
  return result.stdout.trim();
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(name + " is required");
  }
  return value;
}

function optionalEnv(name) {
  return process.env[name] || "";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
