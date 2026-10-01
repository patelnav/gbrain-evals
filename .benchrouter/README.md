# BenchRouter

BenchRouter owns this folder's generated kit for one or more LLM routes in patelnav/gbrain-evals.

## What It Does

BenchRouter compares models using your route's quality tests. Its Personal Pareto Frontier (PPF) shows cost and quality tradeoffs. The baseline is the comparison floor; the best model is the highest-ranked eligible choice. Fallbacks exist only when other models meet the route's policy gates. BenchRouter does not define your quality standard or invent a missing application-level evaluator.

- Your app calls BenchRouter with a route id as the outbound model, using its supported HTTP protocol.
- Registration serves the route's incumbent at once. Default-branch import updates the eval set and is the boundary that admits PR evidence into what the route serves while discovery continues.
- GitHub Actions runs each repository executable route's declared evaluator against one forced candidate and reads its declared result.
- Isolated replay does not run app code. A repository executable route runs only its declared command from the frozen eval commit.

## Credentials

- Runtime host: BENCHROUTER_API_KEY
- Runtime base URL env: ANTHROPIC_BASE_URL = https://api.benchrouter.com
- SDK auth: source its API key from BENCHROUTER_API_KEY. Native Anthropic sends it as x-api-key; OpenAI-compatible clients send it as Bearer.
- GitHub Actions: keyless via GitHub OIDC (no stored eval API key)

## Folder Shape

- .benchrouter/benchrouter.yml is the single route declaration. It owns route ids, code refs, provider wiring, incumbent models, and eval asset paths.
- .benchrouter/bootstrap.mjs verifies a signed runtime before it starts.
- .benchrouter/trust.json holds the current and next signing keys. Its digest-pin list is empty by default.
- For a new route, run npx --yes --package @benchrouter/cli benchrouter init. For an existing route, run npx --yes --package @benchrouter/cli benchrouter upgrade. Upgrade preserves benchrouter.yml byte-for-byte and never replaces cases, scorers, calibration fixtures, setup guides, or app files.
- The workflow, bootstrap and trust metadata are the generated kit. The signed runtime reads route behavior from benchrouter.yml.
- Repository executable routes own their evaluator, frozen lockfile, input refs, acceptance refs, and result contract. Their quality evidence comes from the declared executable result, not an isolated-replay scorer.
- GitHub Actions runs one signed runtime process. Customer setup and evaluator secrets are granted only to server-dispatched runs.
- Add evaluator tools in the workflow customer-setup block. Condition every added step on workflow_dispatch.
- The job ceiling is 120 minutes. Executable evaluators have a 90-minute work cap.
- Do not make this filtered workflow a required GitHub check.

## Commands

- npm run benchrouter:calibrate
- npm run benchrouter:capture
- npx --yes --package @benchrouter/cli benchrouter doctor --phase evaluation --repo patelnav/gbrain-evals

Use .benchrouter/SETUP_README.md for the repo-specific setup steps.
