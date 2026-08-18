# BenchRouter Setup

Version: 0.0.10
Repo: patelnav/gbrain-evals
Base branch: main

The happy path has two user checkpoints:

1. Confirm the route: call site, route id, exact current model, and direct-provider identity when present. This happened before init.
2. Approve env-var install: runtime host key and base URL env.

The confirmed best model is the route's starting served model. BenchRouter records the original model for savings server-side at setup; do not add an original_model field to benchrouter.yml.
When a direct-provider target is shown below, preserve that exact provider and provider-native model reference. Do not replace it with a similar catalog model.

Everything else is agent-owned. Do the smallest BenchRouter patch that works; document scope in the PR instead of asking for routine edit approval.

## Routes
- Route: gbrain-evals/contextual-synopsis
  Base URL env: ANTHROPIC_BASE_URL

## 1. Patch The Call Site

- Patch only the confirmed production LLM call site.
- Send the BenchRouter route id where the old model name was sent.
- Use BENCHROUTER_API_KEY for the BenchRouter path.
- Point the call site's base URL env at https://api.benchrouter.com/v1.
- Preserve request shape, streaming, timeout, auth mechanism, and response parsing.
- If the call site uses a hardcoded provider URL, introduce a runtime base URL env and keep the generated route metadata in sync by rerunning the setup CLI if the route changes.
- If this requires unrelated app refactors, stop and report the blocker.

## 2. Choose The Eval Source

- test-derived: existing tests state the input scenario and expected consumed model decision. Lift the assertion into declared cases and scorer metadata; do not copy the whole test harness.
- captured: no useful assertion exists, but a local app/test flow can capture the exact request and best-model response. Captured reference output is calibration, not truth.
- authored: product intent is defensible from code, schema, fixtures, docs, or user-stated intent. Cite the provenance.
- captured vs authored overlap: use authored intent as the oracle, and use capture for wire fidelity plus best-model calibration.
- If the intended decision is not defensible, mark the route neither-defensible and do not claim a cert.

Customer app code and tests run locally only. CI replays cases; it never runs this repo's test suite.

## 3. Write Cases And Scorer

- Build a coverage matrix first: request-construction branches, prompt templates, response_format/tool schemas, input types, empty/error states, and any routed variants. Cover at least one case per reachable variant or list it as uncovered with a reason.
- Cases live in .benchrouter/cases.<route>.json.
- The sibling README is only a shape guide; keep cases JSON data-only.
- The scorer lives in .benchrouter/scorer.<route>.js.
- The scorer must be standalone and deterministic: no app imports, filesystem, network, DB, clock, randomness, or hidden test runner.
- Grade the output the product consumes. For code-consumed routes, compare parsed fields, tool args, enums, ids, or branches. For human-read routes, score hard constraints deterministically and use metadata.judge only for residual semantic quality.
- Cite a code ref for every check. For consumed-looking fields you ignore, say why downstream does not depend on them.
- If downstream post-processing needs app imports, network, filesystem, DB, clock, live services, another model, search, vector lookup, or a payment/API call, do not call it in CI. Grade the model-output layer the product consumes and flag the downstream gap.
- Regex on prose is wrong unless the literal is exactly what the code consumes.
- Include an import audit in the PR report.

## 4. Calibrate

Run:

```sh
npm run benchrouter:calibrate
```

Record eval_archetype in route or case metadata when it is not obvious. Code-consumed routes need strict local certification and OFFLINE-CERTIFIED: YES. Human-read routes need authored good/broken fixtures and use deterministic mutations as advisory only. Neither-defensible routes must say task-quality UNVERIFIED/no-cert.

The mutation/fixture suite should cover malformed output, empty output, wrong field type, missing consumed field, invalid enum, violated invariant, invalid tool call, and at least one structurally-valid-but-semantically-wrong case. For judged routes, include a valid variation that must pass. A scorer that cannot reject a plausible wrong answer does not ship.

## 5. Install Env Vars After User Approval

- Runtime host secret: BENCHROUTER_API_KEY
- Runtime base URL env: ANTHROPIC_BASE_URL = https://api.benchrouter.com/v1
- GitHub Actions authenticates with GitHub OIDC; no eval API key is stored in the repo.
- If BenchRouter was installed here before, verify the BenchRouter Evals workflow is enabled.

Install the runtime key and base URL env in the app host. Do not leave keys only in chat.

## 6. Verify And Open PR

```sh
npm run benchrouter:calibrate
npx --yes --package @benchrouter/cli benchrouter doctor --repo patelnav/gbrain-evals
```

After finalizing the .benchrouter files, commit them so the stored commit_sha matches the files, then open a PR. The BenchRouter Evals workflow reports the route snapshot with GitHub OIDC; do not run the snapshot reporter locally or supply a local API token. The workflow reports route declarations, fingerprints, path labels, and code_ref hashes. It does not upload app source or authored eval files, is informational, and is never required to merge.

PR body:

1. Call site changed + route ID
2. Eval mode + cases + scorer + calibration
3. Rollback steps
