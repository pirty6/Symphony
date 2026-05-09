/**
 * investigate.ts — The "investigate" pattern.
 *
 * Answer a question about an existing system without modifying it.
 * Output is understanding plus a list of follow-ups, not a code change.
 */

import type { Pattern, PatternScore } from "./types";

const score: PatternScore = {
  pattern: "investigate",
  domain: "investigate",
  beats: [
    {
      step: "clarify",
      level: 3,
      instrument: "order",
      directive:
        "Restate the prompt as the question to investigate. If multi-part or fuzzy, decompose into a numbered list of sub-questions instead. Single-question prompts get a one-line restatement; multi-part prompts get a list.",
    },
    {
      step: "scope",
      level: 3,
      instrument: "order",
      directive:
        "Scope inventory — enumerate the items, files, or behaviors in bounds and explicitly mark what is out. Repo-specific scope qualifiers come from context.scope when present.",
    },
    {
      step: "map",
      level: 3,
      instrument: "analyze",
      directive:
        "Map references — use LSP go-to-references as the primary signal; grep is a supplement for the cases LSP misses (string keys, serialization, dynamic dispatch, runtime config, type-only usages). Output a deduplicated list of `file:line` references, each tagged by how it was found (LSP / grep / dynamic). For each reference, capture what the code actually does (not what its name suggests) and how it relates to the other in-scope items — one entry per reference. Close with a short relationships paragraph. Repo-specific locate hints come from context.locateHints when present.",
    },
    {
      step: "hypothesize",
      level: 4,
      instrument: "question",
      directive:
        "Per sub-question, propose a claim and actively seek counter-evidence (callers that contradict, tests that pin it down, invariants that survive). Output one record per claim: `{claim, verdict: confirmed|falsified|inconclusive, evidence}`. Falsified claims are still output — `answer` consumes them.",
    },
    {
      step: "answer",
      level: 5,
      instrument: "integrate",
      directive:
        "Answer every sub-question (mark answered / partial / open) and bucket each item (keep / remove / change / unresolved). Synthesize confirmed and inconclusive hypotheses into the answer; surface falsified hypotheses as 'believed X, evidence Y says otherwise' so the epistemic delta is visible. The 'unresolved' / 'open' buckets are real — do not force verdicts.",
    },
    {
      step: "recommend",
      level: 5,
      instrument: "order",
      directive:
        "Recommend follow-ups — per item, list next actions tagged with the target pattern (refactor, feature, decide, or 'no action').",
    },
  ],
};

export const investigatePattern: Pattern = {
  score,
  description:
    "Investigate, explore, or explain something about the codebase \u2014 understand how it works, why it behaves a certain way, what something is for, or assess whether to keep it.",
  requiredContext: [],
};
