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
        "Reproduce each reported bug as a failing test — translate context.reproduction into one or more automated tests so that every distinct bug in context.bug has at least one test that fails on current code. When multiple bugs are listed, each must get its own clearly-named test case. Halt if any test cannot be made to fail: that bug is not yet understood and belongs in `investigate`, not here.",
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
      step: "cover",
      level: 4,
      instrument: "integrate",
      directive:
        "Verify every applied fix has a covering regression test. For each bug listed in context.bug, confirm a test exists that (a) would fail without the fix and (b) passes with it. Write new tests for any fix that lacks coverage — do not rely on the reproduce-step tests alone if they were broad or indirect. Skip only when the reproduce tests already provide exact 1:1 coverage per fix.",
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
    "Fix reported bug(s) \u2014 reproduce each as a failing test, locate the minimal cause, apply the smallest change to flip tests green, verify regression-test coverage per fix, then confirm nothing else regressed.",
  requiredContext: ["bug", "reproduction"],
};
