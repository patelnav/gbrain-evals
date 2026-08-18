# BenchRouter

BenchRouter owns this folder's generated kit for one or more LLM routes in patelnav/gbrain-evals.

## What It Does

- Your app calls BenchRouter's OpenAI-compatible base URL with a route id as the model.
- BenchRouter serves the current best model for that route and only swaps after evals pass.
- GitHub Actions replays declared cases against candidates and uploads results.
- The CI eval never runs this app's test suite or imports app code.

## Credentials

- Runtime host: BENCHROUTER_API_KEY
- Runtime base URL env: ANTHROPIC_BASE_URL = https://api.benchrouter.com/v1
- GitHub Actions: keyless via GitHub OIDC (no stored eval API key)

## Folder Shape

- .benchrouter/benchrouter.yml is the single route declaration. It owns route ids, code refs, provider wiring, incumbent models, and eval asset paths.
- .benchrouter/.kit-state.json contains generated-kit bookkeeping only. It never declares routes.
- For a new route, run npx --yes --package @benchrouter/cli benchrouter init. For an existing route, run npx --yes --package @benchrouter/cli benchrouter upgrade. Upgrade preserves benchrouter.yml byte-for-byte and never replaces cases, scorers, calibration fixtures, setup guides, or app files.
- The workflow, upload helper, eval runner, calibration runner, and capture sidecar are generic generated engines. They read route behavior from benchrouter.yml and are safe to replace during an upgrade.
- Cases, scorer, and calibration fixtures are route-owned evidence. Edit them when product behavior, prompts, parsers, or acceptance rules change.
- The workflow and upload helper are plumbing between GitHub Actions and BenchRouter.

## Commands

- npm run benchrouter:calibrate
- npm run benchrouter:eval
- npx --yes --package @benchrouter/cli benchrouter doctor --repo patelnav/gbrain-evals

Use .benchrouter/SETUP_README.md for the repo-specific setup steps.
