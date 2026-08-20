import { readFile } from "node:fs/promises";
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

const SANDBOX_CJS_SHIM = "globalThis.module = { exports: {} };\nglobalThis.exports = globalThis.module.exports;\nglobalThis.require = function (id) {\n  var error = new Error('BenchRouter scorer sandbox: require/import is forbidden (attempted: ' + id + ')');\n  error.benchrouter_error_code = 'sandbox_violation';\n  error.benchrouter_stage = 'scorer';\n  throw error;\n};\nglobalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };";
const SANDBOX_LOCAL_CONSOLE = "var __benchrouter_consoleBridge = globalThis.__benchrouter_hostConsole;\ndelete globalThis.__benchrouter_hostConsole;\nfunction __benchrouter_consoleArgs(args) {\n  var out = [];\n  for (var i = 0; i < args.length; i++) {\n    var value = args[i];\n    if (typeof value === 'string') out.push(value);\n    else {\n      try { out.push(JSON.stringify(value)); }\n      catch (err) { out.push(String(value)); }\n    }\n  }\n  return out;\n}\nfunction __benchrouter_sendConsole(level, args) {\n  if (typeof __benchrouter_consoleBridge === 'function') {\n    __benchrouter_consoleBridge(level, JSON.stringify(__benchrouter_consoleArgs(args)));\n  }\n}\nglobalThis.console = {\n  log: function () { __benchrouter_sendConsole('log', Array.prototype.slice.call(arguments)); },\n  info: function () { __benchrouter_sendConsole('info', Array.prototype.slice.call(arguments)); },\n  warn: function () { __benchrouter_sendConsole('warn', Array.prototype.slice.call(arguments)); },\n  error: function () { __benchrouter_sendConsole('error', Array.prototype.slice.call(arguments)); },\n  debug: function () { __benchrouter_sendConsole('debug', Array.prototype.slice.call(arguments)); }\n};";
const SANDBOX_MEMBRANE = "globalThis.__benchrouter_scorer = (globalThis.module.exports && typeof globalThis.module.exports.score === 'function') ? globalThis.module.exports.score : (globalThis.benchrouterScorer && globalThis.benchrouterScorer.score);\nglobalThis.__benchrouter_makeJudge = function (hostJudge) {\n  return async function judge(messages) {\n    var payload;\n    try { payload = JSON.stringify(messages); } catch (stringifyErr) {\n      throw new Error('judge messages are not serializable');\n    }\n    if (typeof payload !== 'string') { payload = 'null'; }\n    var reply;\n    try {\n      reply = await hostJudge(payload);\n    } catch (hostErr) {\n      throw new Error('judge call failed: ' + (hostErr && hostErr.message ? String(hostErr.message) : String(hostErr)));\n    }\n    return typeof reply === 'string' ? reply : String(reply == null ? '' : reply);\n  };\n};\nglobalThis.__benchrouter_run = async function (payloadJson, judgeWrapper) {\n  var data = JSON.parse(payloadJson);\n  if (judgeWrapper) { if (!data.metadata) data.metadata = {}; data.metadata.judge = judgeWrapper; }\n  if (typeof globalThis.__benchrouter_scorer !== 'function') { throw new Error('scorer score() missing'); }\n  var result = await globalThis.__benchrouter_scorer(data);\n  var checks = result && Array.isArray(result.checks) ? result.checks.map(String) : [];\n  var reasons = result && Array.isArray(result.reasons) ? result.reasons.map(String) : [];\n  return JSON.stringify({ pass: !!(result && result.pass === true), checks: checks, reasons: reasons });\n};";
const SCORER_LOAD_TIMEOUT_MS = 5000;
const SCORER_SCORE_TIMEOUT_MS = 20000;
const MAX_MUTATIONS = 120;
async function main() {
    if (process.argv.slice(2).includes("--replay")) {
        throw new Error("benchrouter:calibrate --replay is not shipped in this kit yet; run offline calibration first, then use CI eval replay for live best-model evidence.");
    }
    const routeFilter = process.env.BENCHROUTER_ROUTE_ID || "";
    const routes = await resolveRoutes();
    const selected = routeFilter
        ? routes.filter((route) => route.routeId === routeFilter || route.slug === routeFilter)
        : routes;
    if (selected.length === 0) {
        throw new Error("No route matched BENCHROUTER_ROUTE_ID=" + JSON.stringify(routeFilter));
    }
    console.log("BenchRouter local scorer calibration");
    console.log("Scorer console is LIVE in this local command. CI evals keep console no-op.");
    let failures = 0;
    for (const route of selected) {
        const ok = await calibrateRoute(route);
        if (!ok)
            failures++;
    }
    if (failures > 0) {
        throw new Error("BenchRouter calibration failed for " + failures + " route(s)");
    }
}
async function calibrateRoute(route) {
    console.log("");
    console.log("== Route " + route.routeId + " ==");
    if (route.evalMode === "repository_executable") {
        return calibrateRepositoryExecutable(route);
    }
    const scorerSource = await readFile(route.scorer, "utf8");
    const allCases = await readCases(route.cases);
    const cases = allCases.filter((testCase) => {
        const routeId = typeof testCase.route === "string" ? testCase.route.trim() : "";
        return routeId.length === 0 || routeId === route.routeId;
    }).filter((testCase) => typeof testCase.id === "string" && testCase.id.length > 0);
    const calibration = await readCalibrationFile(route.calibration);
    const archetype = normalizeArchetype(route.metadata.eval_archetype) ||
        normalizeArchetype(route.metadata.archetype) ||
        calibration.archetype ||
        archetypeFromCaseMetadata(cases) ||
        archetypeFromCases(cases) ||
        archetypeFromFixtures(calibration.fixtures);
    if (!archetype) {
        console.log("Archetype: UNCLASSIFIED");
        console.log("Result: UNVERIFIED - no route archetype or defensible local calibration evidence found.");
        return false;
    }
    console.log("Archetype: " + archetype + archetypeSourceNote(route, calibration, cases));
    if (archetype === "code-consumed") {
        return calibrateStructured(route, scorerSource, cases, calibration.fixtures);
    }
    if (archetype === "human-read") {
        return calibrateHumanRead(route, scorerSource, cases, calibration);
    }
    console.log("Result: UNVERIFIED - this route is marked neither-defensible, so no scorer certification is issued.");
    return false;
}
async function calibrateRepositoryExecutable(route) {
    const executable = route.executable;
    if (!executable) {
        throw new Error("Repository executable route is missing its executable contract: " + route.routeId);
    }
    const declaredRefs = [
        ["config_path", route.evalConfigPath],
        ["workflow", route.workflowPath],
        ["lockfile", executable.lockfile],
        ...executable.inputRefs.map((filePath) => ["input_ref", filePath]),
        ...executable.acceptanceRefs.map((filePath) => ["acceptance_ref", filePath]),
        ...route.caseRefs.map((filePath) => ["case_ref", filePath])
    ];
    const uniqueRefs = new Map();
    for (const [kind, filePath] of declaredRefs) {
        const labels = uniqueRefs.get(filePath) || [];
        labels.push(kind);
        uniqueRefs.set(filePath, labels);
    }
    for (const [filePath, labels] of uniqueRefs) {
        try {
            await readFile(filePath);
        }
        catch (caught) {
            throw new Error("Missing or unreadable repository executable reference " + filePath + " (" + labels.join(", ") + "): " + errorMessage(caught));
        }
    }
    console.log("Mode: repository_executable");
    console.log("Declared command: " + JSON.stringify(executable.argv));
    console.log("Validated executable references: " + uniqueRefs.size);
    console.log("Quality source: " + route.resultSchema + " at " + executable.resultPath + " with primary metric " + executable.primaryMetric);
    console.log("Result: EXECUTABLE DECLARATION VALIDATED");
    console.log("Quality is produced by the declared repository executable result when the evaluator runs. No isolated-replay cases or scorer were loaded.");
    return true;
}
function archetypeSourceNote(route, calibration, cases) {
    if (normalizeArchetype(route.metadata.eval_archetype) || normalizeArchetype(route.metadata.archetype))
        return " (from route metadata)";
    if (calibration.archetype)
        return " (from calibration file)";
    if (archetypeFromCaseMetadata(cases))
        return " (from case metadata)";
    if (archetypeFromCases(cases))
        return " (inferred from structured reference outputs)";
    return " (inferred from fixtures)";
}
async function calibrateStructured(route, scorerSource, cases, explicitFixtures) {
    const report = await runMutationCert(scorerSource, cases, route.scorer, { judge: "probe" });
    console.log(formatReport(report));
    const fixtureResults = await runFixtureChecks(route.scorer, scorerSource, explicitFixtures, []);
    printFixtureResults("Explicit calibration fixtures", fixtureResults);
    const ok = report.certified && fixtureResults.every((result) => result.ok);
    console.log("Result: " + (ok ? "CERTIFIED" : "NOT CERTIFIED"));
    if (!report.certified) {
        console.log("Certification blockers: " + (report.certifiedReasons.join("; ") || "strict mutation-cert failed"));
    }
    return ok;
}
async function calibrateHumanRead(route, scorerSource, cases, calibration) {
    const implicitGood = casesToReferenceFixtures(cases);
    const fixtureResults = await runFixtureChecks(route.scorer, scorerSource, calibration.fixtures, implicitGood);
    printFixtureResults("Human-read fixture calibration", fixtureResults);
    const passCount = fixtureResults.filter((result) => result.expect === "pass").length;
    const failCount = fixtureResults.filter((result) => result.expect === "fail").length;
    let ok = fixtureResults.length > 0 && passCount > 0 && failCount > 0 && fixtureResults.every((result) => result.ok);
    if (passCount === 0 || failCount === 0) {
        console.log("Human-read calibration requires at least one expected pass and one expected fail fixture.");
        ok = false;
    }
    if (cases.length > 0) {
        const advisory = await runMutationCert(scorerSource, cases, route.scorer, { judge: "probe" });
        console.log("");
        console.log("Advisory deterministic mutations (not a human-read cert):");
        console.log(formatReport(advisory));
        console.log("Mutation output above is advisory only for human-read routes; fixture/rubric checks are the hard local gate.");
    }
    console.log("Result: " + (ok ? "CALIBRATED (NO MUTATION-CERT ISSUED)" : "NOT CALIBRATED"));
    return ok;
}
async function runFixtureChecks(scorerName, scorerSource, explicitFixtures, implicitGood) {
    const fixtures = [...implicitGood, ...explicitFixtures].filter((fixture) => fixture.expect === "pass" || fixture.expect === "fail");
    if (fixtures.length === 0)
        return [];
    const scorer = loadScorerFromSource(scorerSource, scorerName);
    const results = [];
    for (let index = 0; index < fixtures.length; index++) {
        const fixture = fixtures[index];
        const expect = fixture.expect === "fail" ? "fail" : "pass";
        const storedOutput = storedFixtureValue(fixture.output !== undefined ? fixture.output : fixture.message);
        const output = messageContent(storedOutput);
        const storedReference = storedFixtureValue(fixture.reference !== undefined ? fixture.reference : fixture.reference_output);
        const reference = messageContent(storedReference);
        const metadata = {
            case_id: fixture.id || fixture.label || "fixture_" + String(index + 1),
            message: parseMessage(storedOutput) || { role: "assistant", content: output },
            reference_message: parseMessage(storedReference),
            ...(fixture.scorer_metadata || fixture.metadata || {})
        };
        let judgeInvoked = false;
        const judgeReply = fixture.judge_reply || fixture.judge_response || (expect === "pass" ? "PASS: local calibration fixture" : "FAIL: local calibration fixture");
        metadata.judge = async () => {
            judgeInvoked = true;
            return judgeReply;
        };
        let actualPass = false;
        let checks = [];
        let reasons = [];
        let error = null;
        try {
            const result = await scorer({
                request: fixture.request,
                output,
                reference,
                metadata
            });
            actualPass = result.pass === true;
            checks = result.checks;
            reasons = result.reasons;
        }
        catch (caught) {
            error = errorMessage(caught);
        }
        results.push({
            label: fixture.label || fixture.id || "fixture_" + String(index + 1),
            expect,
            actualPass,
            ok: !error && (expect === "pass" ? actualPass : !actualPass),
            judgeInvoked,
            checks,
            reasons,
            error
        });
    }
    return results;
}
function printFixtureResults(title, results) {
    console.log("");
    console.log(title + ": " + results.filter((result) => result.ok).length + "/" + results.length + " passed");
    for (const result of results) {
        const actual = result.error ? "error" : result.actualPass ? "pass" : "fail";
        const judge = result.judgeInvoked ? " judge" : "";
        console.log("  " +
            (result.ok ? "OK   " : "FAIL ") +
            result.label +
            " expect=" +
            result.expect +
            " actual=" +
            actual +
            judge +
            (result.error ? " error=" + result.error : result.reasons.length ? " reasons=" + result.reasons.join("; ") : ""));
    }
}
function casesToReferenceFixtures(cases) {
    const fixtures = [];
    for (const testCase of cases) {
        if (typeof testCase.reference_output !== "string" || messageContent(testCase.reference_output).length === 0)
            continue;
        fixtures.push({
            id: testCase.id,
            label: "case:" + testCase.id + ":reference",
            output: testCase.reference_output,
            reference: testCase.reference_output,
            request: testCase.request,
            scorer_metadata: testCase.scorer_metadata || {},
            expect: "pass"
        });
    }
    return fixtures;
}
async function readCalibrationFile(filePath) {
    let text = "";
    try {
        text = await readFile(filePath, "utf8");
    }
    catch (caught) {
        const code = caught && typeof caught.code === "string" ? caught.code : "";
        if (code === "ENOENT")
            return { path: filePath, exists: false, archetype: null, fixtures: [] };
        throw caught;
    }
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
        return { path: filePath, exists: true, archetype: null, fixtures: parsed.filter(isObject) };
    }
    if (isObject(parsed)) {
        const fixtures = Array.isArray(parsed.fixtures) ? parsed.fixtures.filter(isObject) : [];
        return {
            path: filePath,
            exists: true,
            archetype: normalizeArchetype(parsed.archetype) || normalizeArchetype(parsed.eval_archetype),
            fixtures
        };
    }
    throw new Error(filePath + " must be a JSON array of fixtures or an object with { fixtures }");
}
async function readCases(filePath) {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!Array.isArray(parsed)) {
        throw new Error(filePath + " must contain a JSON array of declared eval cases");
    }
    return parsed.filter(isObject);
}
function normalizeArchetype(value) {
    if (typeof value !== "string")
        return null;
    const v = value.trim().toLowerCase().replace(/_/g, "-");
    if (v === "code-consumed" || v === "structured" || v === "structured/code-consumed" || v === "structured-code-consumed")
        return "code-consumed";
    if (v === "human-read" || v === "free-text" || v === "human" || v === "human-read/free-text")
        return "human-read";
    if (v === "neither-defensible" || v === "neither" || v === "unverified" || v === "no-cert")
        return "neither-defensible";
    return null;
}
function archetypeFromCases(cases) {
    let sawReference = false;
    for (const testCase of cases) {
        const stored = typeof testCase.reference_output === "string" ? testCase.reference_output : null;
        const message = parseMessage(stored);
        if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
            return "code-consumed";
        const content = messageContent(stored);
        if (content.length === 0)
            continue;
        sawReference = true;
        if (looksStructured(content))
            return "code-consumed";
    }
    return sawReference ? "human-read" : null;
}
function archetypeFromCaseMetadata(cases) {
    for (const testCase of cases) {
        const metadata = testCase.scorer_metadata || {};
        const archetype = normalizeArchetype(metadata.eval_archetype) || normalizeArchetype(metadata.archetype);
        if (archetype)
            return archetype;
    }
    return null;
}
function archetypeFromFixtures(fixtures) {
    const hasPass = fixtures.some((fixture) => fixture.expect === "pass");
    const hasFail = fixtures.some((fixture) => fixture.expect === "fail");
    return hasPass && hasFail ? "human-read" : null;
}
function looksStructured(value) {
    try {
        const parsed = JSON.parse(value);
        return parsed !== null && typeof parsed === "object";
    }
    catch {
        return false;
    }
}
function storedFixtureValue(value) {
    if (value === undefined || value === null)
        return null;
    return typeof value === "string" ? value : JSON.stringify(value);
}
function parseMessage(stored) {
    if (typeof stored !== "string" || stored.length === 0)
        return null;
    try {
        const obj = JSON.parse(stored);
        if (obj && typeof obj === "object" && !Array.isArray(obj) && ("content" in obj || "tool_calls" in obj || "role" in obj)) {
            return obj;
        }
    }
    catch {
        // plain content string
    }
    return null;
}
function messageContent(stored) {
    if (typeof stored !== "string")
        return "";
    const message = parseMessage(stored);
    if (!message)
        return stored;
    return typeof message.content === "string" ? message.content : "";
}
function errorMessage(caught) {
    return caught && typeof caught.message === "string"
        ? String(caught.message)
        : String(caught);
}
function emptyBucket() {
    return { corruptionCaught: 0, corruptionFalsePass: 0, corruptionNeedsJudge: 0, preservationPass: 0, preservationFalseFail: 0, preservationNeedsJudge: 0 };
}
function tally(bucket, verdict, klass) {
    if (verdict === "caught")
        bucket.corruptionCaught++;
    else if (verdict === "false-pass")
        bucket.corruptionFalsePass++;
    else if (verdict === "pass")
        bucket.preservationPass++;
    else if (verdict === "false-fail")
        bucket.preservationFalseFail++;
    else if (verdict === "needs-judge" && klass === "corruption")
        bucket.corruptionNeedsJudge++;
    else if (verdict === "needs-judge")
        bucket.preservationNeedsJudge++;
}
async function runMutationCert(scorerSource, cases, scorerName, options = {}) {
    const judgeMode = options.judge || "probe";
    const scorer = loadScorerFromSource(scorerSource, scorerName);
    const refContents = cases.map((testCase) => messageContent(testCase.reference_output || null));
    const cardinal = computeCardinalPaths(refContents.filter((value) => value.length > 0));
    const caseReports = [];
    const totals = { cardinal: emptyBucket(), advisory: emptyBucket(), errors: 0, mutationResults: 0, skippedCases: 0 };
    for (let index = 0; index < cases.length; index++) {
        const testCase = cases[index];
        const referenceStored = testCase.reference_output || null;
        const referenceEnvelope = parseMessage(referenceStored);
        const referenceContent = refContents[index] || "";
        if (!referenceContent) {
            const isToolCall = !!referenceEnvelope && Array.isArray(referenceEnvelope.tool_calls);
            totals.skippedCases++;
            caseReports.push({
                caseId: testCase.id,
                referenceContent: "",
                skipped: isToolCall ? "tool-call route (empty content) - content-only mutations cannot certify it" : "no reference content to mutate",
                results: []
            });
            continue;
        }
        const mutations = generateMutations(referenceContent, cardinal);
        const results = [];
        for (const mutation of mutations) {
            const judgeState = { invoked: false };
            const metadata = {
                case_id: testCase.id,
                message: referenceEnvelope ? { ...referenceEnvelope, content: mutation.output } : { role: "assistant", content: mutation.output },
                reference_message: referenceEnvelope,
                ...(testCase.scorer_metadata || {})
            };
            if (judgeMode === "probe") {
                metadata.judge = async () => {
                    judgeState.invoked = true;
                    throw new Error("MUTATION_CERT_NO_JUDGE: offline harness provides no judge model");
                };
            }
            else if (typeof judgeMode === "function") {
                metadata.judge = async (messages) => {
                    judgeState.invoked = true;
                    return judgeMode(messages);
                };
            }
            let scoreResult = null;
            let error;
            try {
                scoreResult = await scorer({ request: testCase.request, output: mutation.output, reference: referenceContent, metadata });
            }
            catch (caught) {
                error = errorMessage(caught);
            }
            const pass = scoreResult?.pass === true;
            let verdict;
            if (error)
                verdict = "error";
            else if (judgeMode === "probe" && judgeState.invoked)
                verdict = "needs-judge";
            else if (mutation.class === "corruption")
                verdict = pass ? "false-pass" : "caught";
            else
                verdict = pass ? "pass" : "false-fail";
            totals.mutationResults++;
            if (verdict === "error")
                totals.errors++;
            else
                tally(mutation.advisory ? totals.advisory : totals.cardinal, verdict, mutation.class);
            results.push({ mutation, pass, judgeInvoked: judgeState.invoked, verdict, reasons: scoreResult?.reasons || [], error });
        }
        caseReports.push({ caseId: testCase.id, referenceContent, results });
    }
    const c = totals.cardinal;
    const reasons = [];
    if (totals.mutationResults < 1)
        reasons.push("no mutation results produced");
    if (totals.skippedCases > 0)
        reasons.push(String(totals.skippedCases) + " case(s) skipped (not certifiable)");
    if (c.corruptionFalsePass > 0)
        reasons.push(String(c.corruptionFalsePass) + " cardinal false-pass on corruptions");
    if (c.preservationFalseFail > 0)
        reasons.push(String(c.preservationFalseFail) + " cardinal false-fail on preservations");
    if (c.corruptionNeedsJudge > 0)
        reasons.push(String(c.corruptionNeedsJudge) + " cardinal corruption(s) need a judge");
    if (c.preservationNeedsJudge > 0)
        reasons.push(String(c.preservationNeedsJudge) + " cardinal preservation(s) need a judge");
    if (totals.errors > 0)
        reasons.push(String(totals.errors) + " scorer error(s)");
    return {
        scorerName,
        judgeMode: typeof judgeMode === "function" ? "real-judge" : judgeMode,
        cardinalPaths: [...cardinal].sort(),
        cases: caseReports,
        totals,
        certified: reasons.length === 0,
        certifiedReasons: reasons
    };
}
function formatReport(report) {
    const c = report.totals.cardinal;
    const a = report.totals.advisory;
    return [
        "Scorer: " + report.scorerName + "  (judge mode: " + report.judgeMode + ")",
        "  -- CARDINAL (counts toward certification) --",
        "  CARDINAL false-pass on corruptions: " + c.corruptionFalsePass + "  " + (c.corruptionFalsePass === 0 ? "(OK)" : "(FAIL)"),
        "  corruptions caught (deterministic): " + c.corruptionCaught,
        "  corruptions needing a judge:        " + c.corruptionNeedsJudge,
        "  preservations passed:               " + c.preservationPass,
        "  preservations false-failed:         " + c.preservationFalseFail,
        "  preservations needing a judge:      " + c.preservationNeedsJudge,
        "  -- ADVISORY (optional fields / order-sensitive; excluded) --",
        "  advisory corruption false-pass:     " + a.corruptionFalsePass,
        "  advisory corruption caught:         " + a.corruptionCaught,
        "  advisory corruption needs-judge:    " + a.corruptionNeedsJudge,
        "  advisory preservation pass/fail/nj: " + a.preservationPass + "/" + a.preservationFalseFail + "/" + a.preservationNeedsJudge,
        "  -- global --",
        "  errors:                             " + report.totals.errors,
        "  skipped cases:                      " + report.totals.skippedCases,
        "  total mutation results:             " + report.totals.mutationResults,
        "  cardinal field paths:               " + (report.cardinalPaths.join(", ") || "(none)"),
        "  OFFLINE-CERTIFIED: " + (report.certified ? "YES" : "NO - " + (report.certifiedReasons.join("; ") || "strict certification failed"))
    ].join("\n");
}
function loadScorerFromSource(source, scorerName) {
    const sandbox = {};
    sandbox.__benchrouter_hostConsole = (level, argsJson) => {
        let args;
        try {
            const parsed = JSON.parse(argsJson);
            args = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
        }
        catch {
            args = [argsJson];
        }
        const method = level === "error" || level === "warn" || level === "info" || level === "debug" ? level : "log";
        console[method]("[benchrouter scorer]", ...args);
    };
    vm.createContext(sandbox);
    vm.runInContext(SANDBOX_CJS_SHIM, sandbox, { timeout: SCORER_LOAD_TIMEOUT_MS });
    vm.runInContext(SANDBOX_LOCAL_CONSOLE, sandbox, { timeout: SCORER_LOAD_TIMEOUT_MS });
    const factory = vm.runInContext("(function (module, exports, require) {\n" + source + "\n})", sandbox, { filename: scorerName, timeout: SCORER_LOAD_TIMEOUT_MS });
    const ctxModule = sandbox.module;
    factory(ctxModule, ctxModule.exports, sandbox.require);
    vm.runInContext(SANDBOX_MEMBRANE, sandbox, { timeout: SCORER_LOAD_TIMEOUT_MS });
    if (typeof sandbox.__benchrouter_scorer !== "function") {
        throw new Error("Scorer " + scorerName + " must export score({request,output,reference,metadata}) -> {pass,checks,reasons}");
    }
    const ctxMakeJudge = sandbox.__benchrouter_makeJudge;
    const ctxRun = sandbox.__benchrouter_run;
    return async (input) => {
        const metadata = input.metadata || {};
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
        const judgeWrapper = hostJudge
            ? ctxMakeJudge((messagesJson) => Promise.resolve(hostJudge(JSON.parse(messagesJson))))
            : null;
        const resultJson = await withDeadline(Promise.resolve(ctxRun(payloadJson, judgeWrapper)), SCORER_SCORE_TIMEOUT_MS, "scorer score() exceeded deadline");
        const parsed = JSON.parse(resultJson);
        return {
            pass: parsed.pass === true,
            checks: Array.isArray(parsed.checks) ? parsed.checks.map(String) : [],
            reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : []
        };
    };
}
function withDeadline(value, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label + " (" + ms + "ms)")), ms);
        Promise.resolve(value).then((resolved) => {
            clearTimeout(timer);
            resolve(resolved);
        }, (rejected) => {
            clearTimeout(timer);
            reject(rejected);
        });
    });
}
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function clone(value) {
    return structuredClone(value);
}
function getAtPath(root, path) {
    let cur = root;
    for (const seg of path) {
        if (cur == null)
            return undefined;
        cur = cur[seg];
    }
    return cur;
}
function parentOf(root, path) {
    if (path.length === 0)
        return null;
    const parent = getAtPath(root, path.slice(0, -1));
    if (parent == null || typeof parent !== "object")
        return null;
    return { parent, key: path[path.length - 1] };
}
function pathLabel(path) {
    return path.length === 0 ? "$" : "$." + path.map((seg) => typeof seg === "number" ? "[" + String(seg) + "]" : seg).join(".");
}
function normalizePath(path) {
    let out = "$";
    for (const seg of path)
        out += typeof seg === "number" ? "[*]" : "." + seg;
    return out;
}
function wrongTypeValue(value) {
    if (typeof value === "string")
        return 12345;
    if (typeof value === "number")
        return "not-a-number";
    if (typeof value === "boolean")
        return "true";
    if (Array.isArray(value))
        return {};
    if (isObject(value))
        return [];
    if (value === null)
        return 0;
    return null;
}
function corruptString(value) {
    if (/^[A-Z][A-Z0-9_]*$/.test(value))
        return { value: value + "_INVALID", kind: "structural", label: "invalid-enum" };
    if (value.length >= 2) {
        const chars = value.split("");
        for (let index = 0; index < chars.length - 1; index++) {
            if (chars[index] !== chars[index + 1]) {
                const tmp = chars[index];
                chars[index] = chars[index + 1];
                chars[index + 1] = tmp;
                return { value: chars.join(""), kind: "semantic", label: "value-corrupt" };
            }
        }
        return { value: value + "X", kind: "semantic", label: "value-corrupt" };
    }
    if (value.length === 1)
        return { value: value + "X", kind: "semantic", label: "value-corrupt" };
    return null;
}
function reorderKeys(obj) {
    const out = {};
    for (const key of Object.keys(obj).reverse())
        out[key] = obj[key];
    return out;
}
function collectStats(node, path, stats) {
    if (isObject(node)) {
        const container = normalizePath(path);
        stats.objectCount.set(container, (stats.objectCount.get(container) || 0) + 1);
        for (const key of Object.keys(node)) {
            const fieldPath = normalizePath([...path, key]);
            stats.containerOfField.set(fieldPath, container);
            const value = node[key];
            if (value !== null && value !== undefined) {
                stats.presentNonNull.set(fieldPath, (stats.presentNonNull.get(fieldPath) || 0) + 1);
            }
            collectStats(value, [...path, key], stats);
        }
    }
    else if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index++)
            collectStats(node[index], [...path, index], stats);
    }
}
function computeCardinalPaths(referenceContents) {
    const stats = { objectCount: new Map(), presentNonNull: new Map(), containerOfField: new Map() };
    for (const content of referenceContents) {
        try {
            const parsed = JSON.parse(content);
            if (parsed !== null && typeof parsed === "object")
                collectStats(parsed, [], stats);
        }
        catch {
            // free-text references have no structured field paths
        }
    }
    const cardinal = new Set();
    for (const [fieldPath, present] of stats.presentNonNull) {
        const container = stats.containerOfField.get(fieldPath);
        if (!container)
            continue;
        const total = stats.objectCount.get(container) || 0;
        if (total > 0 && present === total)
            cardinal.add(fieldPath);
    }
    return cardinal;
}
function emitFieldMutations(parsed, path, cardinal, out) {
    const value = getAtPath(parsed, path);
    const at = pathLabel(path);
    const advisory = !cardinal.has(normalizePath(path));
    const locs = ["remove", "null", "wrong-type"];
    for (const op of locs) {
        const mutated = clone(parsed);
        const loc = parentOf(mutated, path);
        if (!loc)
            continue;
        if (op === "remove") {
            if (Array.isArray(loc.parent))
                loc.parent.splice(loc.key, 1);
            else
                delete loc.parent[loc.key];
            out.push({ id: "corruption:remove:" + at, class: "corruption", kind: "structural", description: "remove field " + at, output: JSON.stringify(mutated), advisory });
        }
        else if (op === "null") {
            loc.parent[loc.key] = null;
            out.push({ id: "corruption:null:" + at, class: "corruption", kind: "structural", description: "null out field " + at, output: JSON.stringify(mutated), advisory });
        }
        else {
            loc.parent[loc.key] = wrongTypeValue(value);
            out.push({ id: "corruption:wrong-type:" + at, class: "corruption", kind: "structural", description: "wrong type for field " + at, output: JSON.stringify(mutated), advisory });
        }
    }
    if (typeof value === "string") {
        const corrupt = corruptString(value);
        if (corrupt) {
            const mutated = clone(parsed);
            const loc = parentOf(mutated, path);
            if (loc) {
                loc.parent[loc.key] = corrupt.value;
                out.push({ id: "corruption:" + corrupt.label + ":" + at, class: "corruption", kind: corrupt.kind, description: corrupt.label + " at " + at, output: JSON.stringify(mutated), advisory });
            }
        }
    }
    else if (typeof value === "number") {
        const mutated = clone(parsed);
        const loc = parentOf(mutated, path);
        if (loc) {
            loc.parent[loc.key] = value + 1;
            out.push({ id: "corruption:value-corrupt:" + at, class: "corruption", kind: "semantic", description: "value-corrupt number at " + at, output: JSON.stringify(mutated), advisory });
        }
    }
}
function walkStructured(parsed, path, cardinal, out) {
    if (out.length >= MAX_MUTATIONS)
        return;
    const node = getAtPath(parsed, path);
    if (isObject(node)) {
        for (const key of Object.keys(node)) {
            if (out.length >= MAX_MUTATIONS)
                return;
            emitFieldMutations(parsed, [...path, key], cardinal, out);
            walkStructured(parsed, [...path, key], cardinal, out);
        }
        if (Object.keys(node).length >= 2) {
            const mutated = clone(parsed);
            const loc = parentOf(mutated, path);
            if (path.length === 0) {
                out.push({ id: "preservation:reorder-keys:" + pathLabel(path), class: "preservation", kind: "format", description: "reorder object keys at " + pathLabel(path), output: JSON.stringify(reorderKeys(mutated)) });
            }
            else if (loc) {
                loc.parent[loc.key] = reorderKeys(node);
                out.push({ id: "preservation:reorder-keys:" + pathLabel(path), class: "preservation", kind: "format", description: "reorder object keys at " + pathLabel(path), output: JSON.stringify(mutated) });
            }
        }
    }
    else if (Array.isArray(node)) {
        if (node.length >= 1) {
            const arrAdvisory = !cardinal.has(normalizePath(path));
            const mutated = clone(parsed);
            const arr = getAtPath(mutated, path);
            arr.splice(0, 1);
            out.push({ id: "corruption:drop-array-elem:" + pathLabel(path), class: "corruption", kind: "semantic", description: "drop first element of array " + pathLabel(path), output: JSON.stringify(mutated), advisory: arrAdvisory });
        }
        if (node.length >= 2) {
            const mutated = clone(parsed);
            const arr = getAtPath(mutated, path);
            arr.reverse();
            out.push({ id: "preservation:reorder-array:" + pathLabel(path), class: "preservation", kind: "format", description: "reverse array order at " + pathLabel(path), output: JSON.stringify(mutated), advisory: true, assumesOrderInsensitive: true });
        }
        if (node.length >= 1)
            walkStructured(parsed, [...path, 0], cardinal, out);
    }
}
function generateMutations(referenceContent, cardinal) {
    const out = [{ id: "preservation:identity", class: "preservation", kind: "identity", description: "unchanged reference (known-good output)", output: referenceContent }];
    let parsed = null;
    let isJson = false;
    try {
        parsed = JSON.parse(referenceContent);
        isJson = parsed !== null && typeof parsed === "object";
    }
    catch {
        isJson = false;
    }
    if (isJson) {
        walkStructured(parsed, [], cardinal, out);
    }
    else {
        const firstWord = referenceContent.trim().split(/\s+/)[0] || "";
        if (firstWord.length > 0 && firstWord !== referenceContent) {
            out.push({ id: "corruption:text-truncated-word", class: "corruption", kind: "semantic", description: "keep only the first word", output: firstWord });
        }
    }
    out.push({ id: "corruption:empty-output", class: "corruption", kind: "structural", description: "empty output", output: "" });
    if (referenceContent.length >= 4)
        out.push({ id: "corruption:truncated", class: "corruption", kind: "structural", description: "truncated to first half", output: referenceContent.slice(0, Math.floor(referenceContent.length / 2)) });
    out.push({ id: "corruption:injected-prose", class: "corruption", kind: "structural", description: "prepend conversational prose", output: "Sure! Here is the result:\n" + referenceContent });
    out.push({ id: "corruption:unrelated", class: "corruption", kind: "semantic", description: "replace with an unrelated answer", output: "I'm sorry, I can't help with that request." });
    if (isJson && referenceContent.length >= 2)
        out.push({ id: "corruption:broken-json", class: "corruption", kind: "structural", description: "drop the final character (breaks JSON)", output: referenceContent.slice(0, -1) });
    if (isJson) {
        const compact = JSON.stringify(parsed);
        if (compact !== referenceContent)
            out.push({ id: "preservation:whitespace-compact", class: "preservation", kind: "format", description: "minified JSON", output: compact });
        const pretty = JSON.stringify(parsed, null, 2);
        if (pretty !== referenceContent && pretty !== compact)
            out.push({ id: "preservation:whitespace-pretty", class: "preservation", kind: "format", description: "pretty JSON", output: pretty });
    }
    else {
        out.push({ id: "preservation:trailing-newline", class: "preservation", kind: "format", description: "add trailing newline", output: referenceContent + "\n" });
        out.push({ id: "preservation:surrounding-space", class: "preservation", kind: "format", description: "add surrounding whitespace", output: "  " + referenceContent + "  " });
    }
    const byKey = new Map();
    for (const mutation of out) {
        const key = mutation.class + " " + mutation.output;
        const existing = byKey.get(key);
        if (!existing || (existing.advisory && !mutation.advisory))
            byKey.set(key, mutation);
    }
    return [...byKey.values()];
}
async function resolveRoutes() {
    const manifest = await readBenchRouterManifest(process.env.BENCHROUTER_CONFIG_PATH || ".benchrouter/benchrouter.yml");
    return manifest.routes.map((route) => ({
        routeId: route.routeId,
        slug: route.slug,
        scorer: route.scorerPath,
        cases: route.casesPath,
        calibration: route.calibrationPath,
        evalMode: route.evalMode,
        executable: route.executable,
        evalConfigPath: route.evalConfigPath,
        workflowPath: route.workflowPath,
        resultSchema: route.resultSchema,
        caseRefs: route.caseRefs,
        metadata: { eval_archetype: route.evalArchetype }
    }));
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
