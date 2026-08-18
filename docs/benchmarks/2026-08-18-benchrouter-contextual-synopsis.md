# BenchRouter — gbrain per-chunk synopsis

**Date:** 2026-08-18
**Route:** `gbrain-evals/contextual-synopsis`
**System under test:** gbrain `4a269868b2253c24d7ae674820534e14ce5e74b8`
**Observed production pin:** `anthropic:claude-haiku-4-5-20251001`

## Question

Which currently available model gives gbrain the cheapest reliable per-chunk
synopsis without losing the entity, time, topic, and query vocabulary that its
contextual-retrieval vectors consume?

The observed Haiku 4.5 model is retired in BenchRouter's catalog. Fable 5 is the
starting active baseline; the observed model remains recorded in route metadata
so the migration is auditable.

## What the BenchRouter frontier certifies

The route replays eight authored cases derived from gbrain's exact synopsis
prompt and its public synthetic corpora. Cases cover:

| Variant | Critical | Consumed behavior |
|---|---:|---|
| funding lead + date | yes | exact company and person anchors |
| role disambiguation | yes | person, role, company, and time |
| pronoun resolution | yes | full-document entity resolution |
| meeting decision | yes | decision, owner, and effective date |
| structural links | no | structural purpose and named resources |
| numeric operating fact | yes | exact amount, count, date, and metric |
| relationship context | no | cross-entity relationship vocabulary |
| superseded temporal fact | yes | current fact without reviving stale state |

The deterministic scorer first enforces gbrain's consumed envelope: non-empty,
one sentence, 15–30 words, at most 300 characters, plain text, no generic
preamble, and preserved exact entity anchors. BenchRouter's isolated semantic
judge then checks faithfulness, retrieval-oriented vocabulary, and absence of
unsupported facts.

Local calibration passes 16/16 good and broken fixtures. Broken fixtures include
empty output, wrong length, multiple sentences, missing entities, a forbidden
preamble, markdown, and a structurally plausible hallucination.

## Certification boundary

This BenchRouter page reports synopsis contract pass rate, model cost, and model
latency. It does **not** claim Recall@5 or Recall@10: BenchRouter's scorer sandbox
cannot import gbrain, open PGLite, call an embedder, or inspect sealed qrels.

Retrieval Recall@5/@10 remains a second, downstream corpus gate. It must ingest a
fixed corpus, reject every page-level title fallback, hold the embedding/search
configuration fixed, and score sealed gold. A model may be synopsis-contract
eligible on the BenchRouter frontier while still awaiting that downstream gate.

## Reproduction

```sh
bun install --frozen-lockfile
bun test test/eval/contextual-synopsis-route.test.ts
npm run benchrouter:calibrate
npx --yes --package @benchrouter/cli benchrouter doctor --repo patelnav/gbrain-evals
```

GitHub Actions evaluates frontier candidates keylessly through GitHub OIDC. No
provider or BenchRouter eval key is stored in the repository.

## Results

Pending the first `BenchRouter Evals` PR run. The BenchRouter route page is the
authoritative live frontier; this report records its scope and methodology.
