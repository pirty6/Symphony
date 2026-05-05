/**
 * investigate.ts — The "investigate" pattern.
 *
 * Answer a question about an existing system without modifying it.
 * Output is understanding plus a list of follow-ups, not a code change.
 *
 * Both clarify modes (restate / decompose) are emitted as separate
 * beats. The runtime executor picks one based on the prompt's shape;
 * the other gets `outcome: "skipped"` on the Performance.
 */

import type { Pattern, PatternScore } from "./types";

const score: PatternScore = {
  pattern: "investigate",
  domain: "investigate",
  beats: [
    {
      step: "clarify-restate",
      level: 1,
      instrument: "percussion",
      directive:
        "Restate the user's prompt as the question to be investigated. Pass-through; no decomposition. Skip when the prompt is multi-part or fuzzy — clarify-decompose handles that case.",
    },
    {
      step: "clarify-decompose",
      level: 5,
      instrument: "piano",
      directive:
        "Decompose the prompt into concrete answerable sub-questions or a numbered list of items. Skip when the prompt is single-question and clean — clarify-restate handles that case. If the prompt has many items and the output of this beat is a single sentence, this beat was done wrong.",
    },
    {
      step: "scope",
      level: 3,
      instrument: "percussion",
      directive:
        "Scope inventory — enumerate the items, files, or behaviors in bounds and explicitly mark what is out. Repo-specific scope qualifiers come from context.scope when present.",
    },
    {
      step: "locate",
      level: 2,
      instrument: "strings",
      directive:
        "Locate references — find every direct and indirect use: dynamic dispatch, string keys, serialization, runtime config, type-only usages. Grep alone is insufficient. Repo-specific locate hints come from context.locateHints when present.",
    },
    {
      step: "read",
      level: 3,
      instrument: "strings",
      directive:
        "Read semantics — at each reference, capture what the code actually does, not what its name suggests. One summary per reference.",
    },
    {
      step: "map",
      level: 3,
      instrument: "strings",
      directive:
        "Map relationships — describe how in-scope items depend on, produce, or consume each other.",
    },
    {
      step: "hypothesize",
      level: 4,
      instrument: "woodwinds",
      directive:
        "Test hypotheses — per sub-question or item, propose a claim and actively seek counter-evidence (callers that contradict, tests that pin it down, invariants that survive).",
    },
    {
      step: "classify",
      level: 4,
      instrument: "brass",
      directive:
        "Classify findings — bucket each item: keep / remove / change / unresolved. The 'unresolved' bucket is real; do not force a verdict.",
    },
    {
      step: "synthesize",
      level: 5,
      instrument: "piano",
      directive:
        "Synthesize answer — answer every sub-question; mark explicitly which are answered, which are partial, which remain open.",
    },
    {
      step: "recommend",
      level: 5,
      instrument: "percussion",
      directive:
        "Recommend follow-ups — per item, list next actions tagged with the target pattern (refactor, feature, decide, or 'no action').",
    },
  ],
};

export const investigatePattern: Pattern = {
  score,
  verbTriggers: [
    "investigate", "explore", "understand", "clarify", "analyze",
    "assess", "evaluate", "examine",
    "how does", "why does", "what is", "is there",
    "should we keep", "is X still useful",
  ],
  requiredContext: [],
};
