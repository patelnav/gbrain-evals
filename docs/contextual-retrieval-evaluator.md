# Cat 26 contextual retrieval evaluator

This evaluator compares three real gbrain embedding paths over the committed
world-v1 fixtures: raw chunks (`none`), title-context chunks (`title`), and
per-chunk synopsis-context chunks (`per_chunk_synopsis`). Every mode imports the
same pages and runs the same hybrid keyword plus vector retrieval query set.
The query set has 35 grounded questions across 15 people, company, and meeting
pages. The corpus has 19 naturally produced chunks, including four multi-chunk
gold pages. No query filler or operative mock is used.

The local receipt reports mean reciprocal rank (MRR) as the primary quality
metric, with Recall@1, Recall@5, and Recall@10 as diagnostics. MRR is bounded
to 0..1. BenchRouter repository-executable mode runs the title path as a fixed
baseline, then routes only the synopsis generation calls through
`anthropic:gbrain-evals/contextual-synopsis`. It reports candidate MRR, baseline
metrics, and signed MRR lift on stderr. The executable result keeps only the
bounded candidate and baseline metrics. Signed lift remains an operator-facing
diagnostic because the result contract accepts only bounded metric values.

BenchRouter routing uses the native Anthropic SDK configuration:
`ANTHROPIC_BASE_URL` is set to the eval base and `ANTHROPIC_API_KEY` is set to
the kit's server-issued `ecall_` token from `BENCHROUTER_API_KEY`. The evaluator does not
install a global fetch wrapper, forge routing headers, or echo model-call IDs.
Call evidence is server-derived. Google embeddings remain a declared external
dependency through `GOOGLE_GENERATIVE_AI_API_KEY`.

Synopsis refusal, fallback, and transport failures fail the candidate run. The
error preserves gbrain's failure class and includes the bounded detail from its
`synopsis-failures-*.jsonl` audit when available. A gbrain `malformed` bucket is
reported as a gbrain classification, not asserted to be a malformed provider
payload. When the bounded detail shows transport markers, the evaluator labels
it `unknown_transport` and preserves the gbrain classification. Contract or
transport failures are not scored as retrieval quality.

Validation that does not use external secrets:

```sh
bun install --frozen-lockfile --offline
bun eval/runner/cat26-contextual-retrieval.ts --validate
```

The live command is:

```sh
bun eval/runner/cat26-contextual-retrieval.ts --benchrouter
```
