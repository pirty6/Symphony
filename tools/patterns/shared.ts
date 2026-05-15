/**
 * shared.ts — Beats reused across multiple patterns.
 *
 * Each export is a fully-formed `PatternBeat`; patterns import and
 * splice into their own `score.beats` array. Centralising these here
 * avoids drift when the directive or instrument needs to change.
 */

import type { PatternBeat } from "./types";

export const LINT_BEAT: PatternBeat = {
  step: "lint",
  level: 1,
  instrument: "order",
  directive:
    "Run `yarn lint:fix` to auto-fix all fixable errors and warnings. Then run `yarn lint` and resolve every remaining error and warning with a code change; only suppress with a lint-disable comment when a fix is genuinely impossible, and include a one-line rationale. Re-run `yarn lint` after each round of fixes until the output is clean (zero errors, zero warnings).",
};

export const DOCS_BEAT: PatternBeat = {
  step: "document",
  level: 3,
  instrument: "order",
  directive:
    "Update documentation — review README, inline doc-comments, and any prose docs (e.g. under docs/) that reference code changed in earlier beats. Update every stale reference: renamed symbols, moved files, changed behavior, new or removed options. Skip this beat only when the change is purely internal with zero public-facing surface (no exported API, no CLI, no config, no user-visible behavior).",
};
