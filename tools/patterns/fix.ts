/**
 * fix.ts — The "fix" pattern.
 *
 * Repair a reported bug. `bug` and `reproduction` are required
 * context: the compiler refuses to produce an executable Score
 * without a concrete defect description and a way to trigger it.
 */

import type { Pattern, PatternScore } from "./types";
import { LINT_BEAT } from "./shared";

const score: PatternScore = {
  pattern: "fix",
  domain: "fix",
  beats: [
    {
      step: "reproduce",
      level: 4,
      instrument: "decide",
      directive:
        "Reproduce the bug as a failing test — translate context.reproduction into an automated test that fails on current code and pins the reported behavior (context.bug). Halt if the test cannot be made to fail: the bug is not yet understood and the work belongs in `investigate`, not here.",
    },
    {
      step: "diagnose",
      level: 4,
      instrument: "analyze",
      directive:
        "Diagnose the minimal cause — narrow to the specific code path responsible for the failing test. Scope is \"where does this bug come from\", not investigate's broad \"how does this system work\"; stop at the smallest surface that explains the failure.",
    },
    {
      step: "fix",
      level: 2,
      instrument: "order",
      directive:
        "Apply the smallest change that flips the failing test green. Avoid drive-by edits — anything beyond the minimum to fix the bug belongs in a separate refactor.",
    },
    {
      step: "regress",
      level: 4,
      instrument: "integrate",
      directive:
        "Run the full test suite plus the new regression test; all must pass. This is not an equivalence check — behavior changed by design — but every previously green test must remain green.",
    },
    LINT_BEAT,
  ],
};

export const fixPattern: Pattern = {
  score,
  description:
    "Fix a reported bug \u2014 reproduce it as a failing test, locate the minimal cause, apply the smallest change to flip the test green, then verify nothing else regressed.",
  requiredContext: ["bug", "reproduction"],
};
