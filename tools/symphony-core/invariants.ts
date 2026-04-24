/**
 * invariants.ts — Framework-level invariant checks.
 *
 * checkProgress: detects stalls in execution traces (pure function, tier 2 testable).
 * validateVerdict: enforces MoveVerdict schema at the assessor→Composer boundary.
 */

import type {
  CatalogMove,
  IterationRecord,
  MoveVerdict,
  ValidatorRegistry,
} from "./types";
import { SchemaError, VerdictValidationError } from "./errors";

// ── Progress Invariant ─────────────────────────────────────────────
// No (moveType, targetSite) pair appears twice with the same stateHash
// and outcome 'applied' or 'failed'. Skipped moves are excluded —
// a skip can be revisited if preconditions change (stateHash differs).

export function checkProgress(trace: IterationRecord[]): boolean {
  const seen = new Map<string, Set<string>>();
  for (const r of trace) {
    if (r.outcome === "skipped") continue;
    const key = `${r.moveType}::${r.targetSite}`;
    const hashes = seen.get(key) ?? new Set<string>();
    if (hashes.has(r.stateHash)) return false; // stall detected
    hashes.add(r.stateHash);
    seen.set(key, hashes);
  }
  return true;
}

// ── Verdict Validation ─────────────────────────────────────────────
// Enforces the MoveVerdict schema at the assessor→Composer boundary.
// If any field is malformed, throws VerdictValidationError immediately
// before state mutation occurs.

const VALID_OUTCOMES = ["success", "partial", "failed"] as const;

export function validateVerdict(
  verdict: unknown,
  move: CatalogMove,
  registry: ValidatorRegistry,
): asserts verdict is MoveVerdict {
  if (verdict === null || verdict === undefined || typeof verdict !== "object") {
    throw new VerdictValidationError("verdict", "object", verdict, move.moveType);
  }

  const v = verdict as Record<string, unknown>;

  // outcome: must be 'success' | 'partial' | 'failed'
  if (!VALID_OUTCOMES.includes(v.outcome as typeof VALID_OUTCOMES[number])) {
    throw new VerdictValidationError(
      "outcome",
      VALID_OUTCOMES.join(" | "),
      v.outcome,
      move.moveType,
    );
  }

  // confidence: number in [0, 1]
  if (typeof v.confidence !== "number" || v.confidence < 0 || v.confidence > 1) {
    throw new VerdictValidationError(
      "confidence",
      "number in [0, 1]",
      v.confidence,
      move.moveType,
    );
  }

  // shouldTerminate: boolean
  if (typeof v.shouldTerminate !== "boolean") {
    throw new VerdictValidationError(
      "shouldTerminate",
      "boolean",
      v.shouldTerminate,
      move.moveType,
    );
  }

  // reason: non-empty string
  if (typeof v.reason !== "string") {
    throw new VerdictValidationError(
      "reason",
      "string",
      v.reason,
      move.moveType,
    );
  }

  // targetSite: validated via the registry against move's targetSiteSchema
  assertTargetSite(v, "targetSite", move.targetSiteSchema, move.moveType, registry);
}

/**
 * Validates targetSite against the move's declared schema using
 * the validator registry. Throws SchemaError if no validator is
 * registered (should have been caught at initialization).
 * Throws VerdictValidationError if the value doesn't conform.
 */
function assertTargetSite(
  verdict: Record<string, unknown>,
  field: string,
  schema: string,
  moveType: string,
  registry: ValidatorRegistry,
): void {
  const validator = registry.get(schema);
  if (!validator) {
    throw new SchemaError(
      `No validator registered for targetSiteSchema '${schema}'`,
    );
  }
  const value = verdict[field];
  if (!validator(value)) {
    throw new VerdictValidationError(field, schema, value, moveType);
  }
}
