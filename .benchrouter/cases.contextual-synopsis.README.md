# BenchRouter Eval Cases

Shape doc only. Add real cases to the sibling JSON file; do not put docs or examples inside the data array.

Each real case should include:

- `id`: stable case identifier.
- `route`: `gbrain-evals/contextual-synopsis`.
- `critical`: optional boolean for must-not-regress behavior.
- `input` or `messages`: replayable request sent to the candidate. Prefer `input` for the full captured request body.
- `request`: structured app-level input passed to the scorer.
- `reference_output`: optional best-model capture for calibration, not a gold answer.
- `scorer_metadata`: expected consumed decision and provenance the scorer reads.
- `mode`: `isolated` or `trajectory`.
- `dependent`: true when the request embeds a prior model output.

Capture redacts secrets and personal data before writing cases.
