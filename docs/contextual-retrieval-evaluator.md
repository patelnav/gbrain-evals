# Contextual synopsis evaluator

gbrain can write a short synopsis for every chunk before it embeds the chunk
(`search.contextual_retrieval = per_chunk_synopsis`). The synopsis names the
people, companies, dates and topic of the chunk and is embedded with it, so the
stored vector carries those names even when the chunk itself uses first names,
pronouns or shorthand. This evaluator measures how much of the required
evidence that setting puts in the top five search results, and lets BenchRouter
compare synopsis models on the same measurement.

Runner: `eval/runner/benchrouter-contextual-synopsis.ts`.
BenchRouter route: `gbrain-evals/contextual-synopsis`, eval pack
`contextual_synopsis_amara_life_v1`.

## Corpus and questions

The corpus is all 424 items of `eval/data/amara-life-v1`, a fictional
venture investor's inbox: 50 emails, 300 Slack messages, 20 calendar events,
40 personal notes, 8 meeting transcripts and 6 reference documents.
`eval/runner/amara-life-pages.ts` turns each manifest item into one gbrain page
under its manifest slug. Markdown items pass through unchanged. Emails, Slack
messages and calendar events become short Markdown pages that keep the
subject, sender, recipients, channel, timestamp, thread and body. Every page
fits in one gbrain chunk, so the synopsis situates a whole item rather than a
fragment of a long page. That is the common case for chat and email.

`eval/data/contextual-synopsis-amara-life/queries.json` holds 93 hand-written
questions with 110 distinct labelled pages. They cover every item type:

- 78 `single_fact` questions ask for a fact that one item, or a small set of
  items, states.
- 15 `conflicting_sources` questions ask for a fact that the corpus states with
  planted conflicting or outdated values, such as two different Series A sizes
  for Meridian Solar. Every page that carries a value is relevant, because an
  agent needs to see the conflict.

Each question lists `evidence` substrings. `--validate` requires the set of
pages that contain all of them to equal the question's `relevant_slugs`
exactly. This catches a missing label and a label on a page that does not
state the fact. It checks wording, not meaning, so a page that states the fact
in entirely different words would escape it; the labels were also checked by
reading the corpus.

The questions were written on 2026-09-22 before any synopsis run on this
corpus. They do not reuse `qrels/v0.41-launch.qrels.json`, which labels a
different corpus. The historical 97.9% Recall@5 in the April 2026 multi-adapter
report used world-v1 and older metric code; it is not a target for this set.

## Retrieval settings

Each mode imports the corpus into a fresh in-memory PGLite brain and re-embeds
every page:

- `none`: raw chunk text.
- `title`: chunk text with the page title prepended.
- `per_chunk_synopsis`: chunk text with the title and a model-written synopsis
  prepended.

Embeddings are fixed at `google:gemini-embedding-001` with 1,536 dimensions.
Search is gbrain hybrid keyword plus vector search in `balanced` mode with the
reranker, query expansion and search cache pinned off, so the synopsis model is
the only variable between candidates.

## Metrics

- **Recall@5** (primary): for each question, the share of labelled pages among
  the first five distinct result pages, averaged over questions.
- **Recall-all@5**: 1 when every labelled page is in the first five, else 0.
- **Recall@1, Recall@10 and MRR**: diagnostics.
- Recall@5 split by question kind.

## BenchRouter mode

`--benchrouter` runs `title` as a fixed baseline and `per_chunk_synopsis` as
the candidate. Only synopsis calls go through
`anthropic:gbrain-evals/contextual-synopsis`: `ANTHROPIC_BASE_URL` is set to the
eval base and `ANTHROPIC_API_KEY` to the kit's server-issued `ecall_` token from
`BENCHROUTER_API_KEY`. The evaluator does not install a fetch wrapper, forge
routing headers or echo model-call IDs. BenchRouter derives the call ledger and
cost on its side.

The result file `.benchrouter/executable-result.json` has
`primary_metric.name = recall_at_5` with the candidate's Recall@5, plus
`candidate_*` and `baseline_*` Recall@1/5/10, Recall-all@5, MRR and
per-kind Recall@5. Stderr adds the signed Recall@5 lift and one line per
question per mode with its Recall@5 and top five pages.

A run makes one synopsis call per chunk: 424 calls. The pack allows 480 calls
for gateway retries, $2 per run, $0.25 per call and 60 minutes.

Synopsis refusal, fallback and transport failures fail the candidate run. The
error keeps gbrain's failure class and the bounded detail from its
`synopsis-failures-*.jsonl` audit when available. When that detail shows
transport markers, the evaluator labels the failure `unknown_transport` and
keeps the gbrain classification. Failures are not scored as retrieval quality.
The corpus includes planted prompt-injection messages (see
`eval/data/gold/poison.json`); a candidate model that refuses to summarize one
fails the run rather than scoring lower.

## Commands

Validation without external secrets:

```sh
bun install --frozen-lockfile
bun eval/runner/benchrouter-contextual-synopsis.ts --validate
npm run benchrouter:calibrate
```

Local runs with `GOOGLE_GENERATIVE_AI_API_KEY` (add `ANTHROPIC_API_KEY` for
`per_chunk_synopsis`; the local synopsis model defaults to
`anthropic:claude-haiku-4-5-20251001` and follows
`GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL`):

```sh
bun eval/runner/benchrouter-contextual-synopsis.ts --modes none,title
bun eval/runner/benchrouter-contextual-synopsis.ts
```

Local receipts, with per-question results, go to
`eval/reports/contextual-synopsis/`.

BenchRouter mode, as the workflow runs it:

```sh
bun run eval:contextual-synopsis
```

## History: cat26 fixture

Until this graduation the route ran a 15-page world-v1 fixture
(`eval/data/cat26-contextual-retrieval/`) with 35 questions and four
multi-chunk gold pages, and reported MRR as its primary metric. Those results
were measured on a different corpus with a different primary metric and do not
compare with amara-life-v1 Recall@5. The fixture stays in the repository and
the runner still accepts it for local reproduction:

```sh
bun eval/runner/benchrouter-contextual-synopsis.ts --validate --corpus cat26
bun eval/runner/benchrouter-contextual-synopsis.ts --corpus cat26
```
