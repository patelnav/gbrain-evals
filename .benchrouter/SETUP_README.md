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
  Wire protocol: native Anthropic Messages
  Eval mode: repository executable
  Direct provider target: anthropic / claude-haiku-4-5-20251001
  Observed provider model: anthropic:claude-haiku-4-5-20251001
  Resolved serving identity: anthropic/claude-haiku-4.5 (the exact provider ref is retained; this is not a model replacement)

## 1. Patch The Call Site

- Patch only the confirmed production LLM call site.
- Preserve the supported wire protocol: OpenAI Chat Completions or native Anthropic Messages.
- Send the BenchRouter route id as the outbound model. If a wrapper needs a provider prefix to select the transport, use a value such as anthropic:<route-id> and verify that its outbound body model is the unprefixed route id.
- Source the call site's SDK API key from BENCHROUTER_API_KEY. Native Anthropic sends this value as x-api-key. OpenAI-compatible clients send it as Bearer.
- Point the call site's base URL env at https://api.benchrouter.com. ANTHROPIC_BASE_URL uses the API root because the SDK appends /v1/messages; OpenAI-compatible base URLs include /v1.
- Keep native Anthropic Messages calls non-streaming. BenchRouter rejects stream: true until native SSE accounting ships. Stop if the confirmed call site requires streaming.
- If the call site uses a hardcoded provider URL, introduce a runtime base URL env and keep the generated route metadata in sync by rerunning the setup CLI if the route changes.
- If this requires unrelated app refactors, stop and report the blocker.

## 2. Validate The Repository Executable Eval

Routes: gbrain-evals/contextual-synopsis

- Keep the exact manifest argv, runtime, runtime version, frozen lockfile, input_refs, acceptance_refs, result_path, primary_metric, call limit, spend limits, and timeout.
- Treat case_refs as declared executable evidence files. They can use the evaluator's native shape, including object-shaped qrels. Do not rewrite them as isolated-replay case arrays.
- Do not create an isolated-replay cases file, scorer, or scorer calibration fixture for these routes.
- Confirm every declared config, workflow, lockfile, input, acceptance, and case reference exists in the repository.
- Confirm the evaluator writes benchrouter.executable_result.v1 at result_path with the declared primary metric and the exact BenchRouter model_call_ids it received.
- Quality is produced by the declared executable result after the evaluator runs. Local calibration does not run the evaluator and does not certify task quality.

## 3. Calibrate The Executable Declaration

Run:

```sh
npm run benchrouter:calibrate
```

This validates the executable manifest and declared reference files. It treats case_refs as opaque evaluator inputs. It does not parse isolated-replay cases or load a scorer.

## 5. Install Env Vars After User Approval

- Runtime host secret: BENCHROUTER_API_KEY
- Runtime base URL env: ANTHROPIC_BASE_URL = https://api.benchrouter.com
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
2. Eval mode + executable refs + result contract + declaration calibration
3. Rollback steps
