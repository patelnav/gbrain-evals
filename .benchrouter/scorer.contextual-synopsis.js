"use strict";

// Standalone scorer for gbrain's human-read per-chunk synopsis output.
// Import audit: no imports, fs, network, DB, clock, or randomness. The only
// outbound capability is metadata.judge, injected and metered by BenchRouter.

function normalizedText(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function wordCount(value) {
  var words = normalizedText(value).match(/[\p{L}\p{N}$%][\p{L}\p{N}'’.$%/-]*/gu);
  return words ? words.length : 0;
}

function sentenceCount(value) {
  var text = normalizedText(value);
  if (!text) return 0;
  var matches = text.match(/[.!?](?:["'”’)]*)?(?=\s|$)/g);
  return matches ? matches.length : 0;
}

function literalTermsMissing(text, terms) {
  var lower = text.toLocaleLowerCase("en-US");
  return (Array.isArray(terms) ? terms : []).filter(function (term) {
    return !lower.includes(String(term).toLocaleLowerCase("en-US"));
  });
}

async function score(input) {
  var output = normalizedText(input.output);
  var metadata = input.metadata || {};
  var request = input.request || {};
  var checks = [];
  var reasons = [];

  if (!output) reasons.push("empty synopsis triggers gbrain's page-level title fallback");
  else checks.push("non-empty after sanitizeSynopsis (gbrain page-summary.ts / embedding-context.ts)");

  if (output.length > 300) reasons.push("synopsis exceeds gbrain's 300-character consumed cap");
  else checks.push("within the 300-character consumed envelope");

  var words = wordCount(output);
  if (words < 15 || words > 30) reasons.push("synopsis must contain 15-30 words; got " + words);
  else checks.push("15-30 word prompt contract");

  var sentences = sentenceCount(output);
  if (sentences !== 1) reasons.push("synopsis must be exactly one sentence; got " + sentences);
  else checks.push("one-sentence prompt contract");

  if (/^(?:this|the) chunk (?:is|covers|describes|discusses)\b/i.test(output)) {
    reasons.push("forbidden generic preamble");
  } else {
    checks.push("no generic chunk preamble");
  }

  if (/[`#*_]|<\/?[a-z][^>]*>/i.test(output)) reasons.push("output contains markdown or XML markup");
  else checks.push("plain-text output contract");

  var missing = literalTermsMissing(output, request.required_exact_terms);
  if (missing.length > 0) reasons.push("missing exact retrieval anchor(s): " + missing.join(", "));
  else checks.push("required exact entity anchors preserved");

  if (reasons.length > 0) return { pass: false, checks: checks, reasons: reasons };

  if (typeof metadata.judge !== "function") {
    return { pass: false, checks: checks, reasons: ["semantic judge unavailable"] };
  }

  var judgePrompt = [
    "You are the conservative semantic gate for a contextual-retrieval synopsis.",
    "Return exactly PASS or FAIL: <brief reason>.",
    "PASS only when the candidate is faithful to the supplied chunk and full-document context,",
    "orients the chunk with its correct entity/time/topic, contains useful vocabulary for the",
    "listed retrieval queries, and introduces no unsupported fact.",
    "",
    "PAGE TITLE: " + normalizedText(request.page_title),
    "FULL DOCUMENT: " + normalizedText(request.full_document),
    "CHUNK: " + normalizedText(request.chunk),
    "TARGET RETRIEVAL QUERIES: " + (Array.isArray(request.retrieval_queries) ? request.retrieval_queries.join(" | ") : ""),
    "CANDIDATE SYNOPSIS: " + output
  ].join("\n");
  var judgment = normalizedText(await metadata.judge([
    { role: "system", content: "Judge factual faithfulness and retrieval orientation; be strict." },
    { role: "user", content: judgePrompt }
  ]));
  if (judgment === "PASS" || judgment.startsWith("PASS:")) {
    checks.push("semantic faithfulness and retrieval-orientation judge");
    return { pass: true, checks: checks, reasons: [] };
  }
  return { pass: false, checks: checks, reasons: [judgment || "semantic judge returned no decision"] };
}

if (typeof module !== "undefined" && module.exports) module.exports = { score: score };
else if (typeof globalThis !== "undefined") globalThis.benchrouterScorer = { score: score };
