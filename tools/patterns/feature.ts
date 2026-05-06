/**
 * feature.ts — The "feature" pattern.
 *
 * Add a new capability to an existing system. `scope` and `contract`
 * are required context: the compiler will not produce an executable
 * Score without them.
 */

import type { Pattern, PatternScore } from "./types";

const score: PatternScore = {
  pattern: "feature",
  domain: "feature",
  beats: [
    {
      step: "define",
      level: 4,
      instrument: "decide",
      directive: "Define scope — inputs, outputs, and boundary. Pulled from context.scope.",
    },
    {
      step: "survey",
      level: 3,
      instrument: "question",
      directive:
        "Survey neighbors — locate the modules, types, and conventions the feature will touch.",
    },
    {
      step: "specify",
      level: 4,
      instrument: "analyze",
      directive:
        "Specify contract — public signature, data shapes, error modes. Pulled from context.contract. Known edges from context.knownEdges (if any) feed the next beat.",
    },
    {
      step: "test",
      level: 4,
      instrument: "decide",
      directive:
        "Test contract and known edges — write tests for each named behavior and each known edge case. Tests must fail until implementation lands.",
    },
    {
      step: "sketch",
      level: 5,
      instrument: "integrate",
      directive:
        "Sketch design — choose the internal structure and name the components that will implement the contract.",
    },
    {
      step: "implement",
      level: 2,
      instrument: "order",
      directive: "Implement core — write the primary code path until the contract tests pass.",
    },
    {
      step: "cover",
      level: 2,
      instrument: "decide",
      directive:
        "Cover discovered edges — handle edge cases that surfaced during implementation; add a test for each before fixing.",
    },
    {
      step: "verify",
      level: 4,
      instrument: "integrate",
      directive:
        "Verify integration — run the full suite and confirm the feature composes with existing code.",
    },
  ],
};

export const featurePattern: Pattern = {
  score,
  description:
    "Build, add, or ship a new feature \u2014 introduce new functionality with a clear contract and integration into the existing system.",
  requiredContext: ["scope", "contract"],
};
