/**
 * refactor.ts — The "refactor" pattern.
 *
 * Change the shape of existing code without changing observable
 * behavior. The named-target halt rule from v1 is now enforced by
 * `requiredContext: ["target", "invariant"]`: the compiler refuses to
 * produce an executable Score if either is missing.
 */

import type { Pattern, PatternScore } from "./types";

const score: PatternScore = {
  pattern: "refactor",
  domain: "refactor",
  beats: [
    {
      step: "frame",
      level: 4,
      instrument: "analyze",
      directive:
        "Frame the change — name the structural target (context.target) and pin the invariant preserved across it (context.invariant); state explicitly what is allowed to change (import paths, file layout, internal names).",
    },
    {
      step: "survey",
      level: 3,
      instrument: "analyze",
      directive:
        "Survey blast radius — enumerate every reference. Distinguish symbol-level (imports, calls, type usages — AST/LSP) from string-level (docs, comments, configs, serialized data, log queries — only grep + human reading finds these). Renames and splits fail silently when string-level surveys are skipped.",
    },
    {
      step: "capture",
      level: 1,
      instrument: "order",
      directive:
        "Capture baseline — run tests, types, and build BEFORE any edit on the surface this refactor touches. Record the green state. context.baselineCommand may pin the exact command. If red on the touched surface, halt.",
    },
    {
      step: "plan",
      level: 3,
      instrument: "order",
      directive:
        "Plan move — describe the sequence of mechanical edits in order (introduce new name → update call sites → relocate → delete shim) and mark reversible checkpoints between them. For merge/consolidate, prove behavioral equivalence first.",
    },
    {
      step: "execute",
      level: 2,
      instrument: "order",
      directive:
        "Execute edits — apply the plan in order. Tag any scaffolding (deprecation shim, alias, parallel implementation) at the moment of introduction so pruning is mechanical.",
    },
    {
      step: "verify",
      level: 4,
      instrument: "integrate",
      directive:
        "Verify equivalence — re-run the baseline commands covering the survey surface from beat 'survey'. Integration tests outside the default run may need to be triggered explicitly.",
    },
    {
      step: "prune",
      level: 2,
      instrument: "decide",
      directive:
        "Prune scaffolding — remove every item tagged in beat 'execute'. Re-verify equivalence. Dead aliases rot quickly and the second pass rarely happens.",
    },
  ],
};

export const refactorPattern: Pattern = {
  score,
  description:
    "Restructure existing code without changing observable behavior \u2014 rename, extract, inline, consolidate, dedupe, move, split.",
  requiredContext: ["target", "invariant"],
};
