/**
 * eval-toolchain.ts — Four pure functions for eval suite management.
 *
 * 1. requiredEvalCoverage(entry)  → requirements (what must exist)
 * 2. verifyCoverage(reqs, decls)  → report (pass/fail + missing points)
 * 3. generateEvalScaffold(entry, gaps) → skeleton EvalCase[] with TODO fields
 *
 * readEvalMetadata (step 2 of the pipeline) requires filesystem access
 * and is left to the CLI/tooling layer.
 *
 * All three functions are pure, deterministic, and tier 1 testable.
 */

import type {
  CatalogEntry,
  CoveragePoint,
  CoverageReport,
  EvalCase,
  EvalRequirement,
  TODO,
} from "./types";

/**
 * Derives minimum eval coverage requirements from a catalog entry's schema.
 * Adding new strategyResolution variants auto-creates new requirements.
 */
export function requiredEvalCoverage(entry: CatalogEntry): EvalRequirement[] {
  const reqs: EvalRequirement[] = [
    { type: "existence", min: 1 },
    { type: "terminates-success", min: 1 },
    { type: "terminates-exhaustion", min: 1 },
  ];

  if (entry.resolution.confidence === "heuristic" || entry.resolution.fallback) {
    reqs.push({ type: "assessor-invoked", min: 1 });
  }

  return reqs;
}

/**
 * Cross-references requirements against coverage declarations.
 * Returns pass/fail and a list of missing coverage points.
 */
export function verifyCoverage(
  requirements: EvalRequirement[],
  declarations: CoveragePoint[],
): CoverageReport {
  const missing: CoveragePoint[] = [];

  for (const req of requirements) {
    const count = declarations.filter((d) => d === req.type).length;
    if (count < req.min) {
      missing.push(req.type);
    }
  }

  return {
    passed: missing.length === 0,
    missing,
  };
}

/**
 * Generates skeleton eval cases for each coverage gap.
 * Human fills in `input` and `expectedVerdict` (typed as TODO).
 */
export function generateEvalScaffold(
  catalogEntry: string,
  gaps: CoveragePoint[],
): EvalCase[] {
  return gaps.map((point) => {
    const assessorMode: EvalCase["assessorMode"] =
      point === "assessor-invoked" ? "heuristic" : "deterministic";
    const expectedTermination: EvalCase["expectedTermination"] =
      point === "terminates-exhaustion" ? "exhaustion" : "success";

    return {
      catalogEntry,
      coverage: [point],
      assessorMode,
      expectedTermination,
      input: undefined as TODO,
      expectedVerdict: undefined as TODO,
    };
  });
}
