# BenchRouter

BenchRouter owns this folder's generated kit for one or more LLM routes in patelnav/gbrain-evals.

## What It Does

- Your app calls BenchRouter through OpenAI Chat Completions or native Anthropic Messages, with a route id as the outbound model.
- BenchRouter serves the current best model for that route and only swaps after evals pass.
- GitHub Actions runs each repository executable route's declared evaluator against one forced candidate and reads its declared result.
- Isolated replay does not run app code. A repository executable route runs only its declared command from a frozen default-branch commit.

## Credentials

- Runtime host: BENCHROUTER_API_KEY
- Runtime base URL env: ANTHROPIC_BASE_URL = https://api.benchrouter.com
- SDK auth: source its API key from BENCHROUTER_API_KEY. Native Anthropic sends it as x-api-key; OpenAI-compatible clients send it as Bearer.
- GitHub Actions: keyless via GitHub OIDC (no stored eval API key)

## Folder Shape

- .benchrouter/benchrouter.yml is the single route declaration. It owns route ids, code refs, provider wiring, incumbent models, and eval asset paths.
- .benchrouter/.kit-state.json contains generated-kit bookkeeping only. It never declares routes.
- For a new route, run npx --yes --package @benchrouter/cli benchrouter init. For an existing route, run npx --yes --package @benchrouter/cli benchrouter upgrade. Upgrade preserves benchrouter.yml byte-for-byte and never replaces cases, scorers, calibration fixtures, setup guides, or app files.
- The workflow, upload helper, eval runner, calibration runner, and capture sidecar are generic generated engines. They read route behavior from benchrouter.yml and are safe to replace during an upgrade.
- Repository executable routes own their evaluator, frozen lockfile, input refs, acceptance refs, and result contract. Their quality evidence comes from the declared executable result, not an isolated-replay scorer.
- The workflow and upload helper are plumbing between GitHub Actions and BenchRouter.

## Commands

- npm run benchrouter:calibrate
- npm run benchrouter:eval
- npx --yes --package @benchrouter/cli benchrouter doctor --repo patelnav/gbrain-evals

Use .benchrouter/SETUP_README.md for the repo-specific setup steps.
