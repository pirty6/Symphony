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
    "Run `npm run lint` (oxlint). If `--fix`-able, apply `npm run lint:fix`. Halt if any error remains; remaining errors require either a code fix or an explicit lint-disable with rationale.",
};
