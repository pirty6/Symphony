/**
 * legality.ts — The (Level, Instrument) legality matrix.
 *
 * Some pairings are semantically incoherent ("explore" a single line of
 * code makes no sense — you read it). Others are merely unusual but
 * legitimate. The matrix is three-valued so the validator and the
 * planner can react differently:
 *
 *   - `illegal`  → score validator rejects
 *   - `unusual`  → score generator applies a path-planning penalty
 *   - `legal`    → no constraint
 *
 * The matrix is intentionally sparse. Any pair not listed defaults to
 * `legal`. Demotions of `unusual` → `legal` should come from observed
 * Performance success rates across many runs, not from intuition.
 */

import type { InstrumentType, Legality, Level, Voice } from "./types";

interface LegalityRule {
  readonly level: Level;
  readonly instrument: InstrumentType;
  readonly verdict: Exclude<Legality, "legal">;
  readonly rationale: string;
}

const RULES: readonly LegalityRule[] = [
  {
    level: 1,
    instrument: "woodwinds",
    verdict: "illegal",
    rationale: "exploration has no surface area at the artifact level — read, do not explore",
  },
  {
    level: 1,
    instrument: "piano",
    verdict: "illegal",
    rationale: "nothing to integrate at the artifact level — no other voices have been heard yet",
  },
  {
    level: 7,
    instrument: "percussion",
    verdict: "illegal",
    rationale: "first principles do not have a sequence — ordering presupposes operations to order",
  },
  {
    level: 8,
    instrument: "percussion",
    verdict: "illegal",
    rationale: "first principles do not have a sequence — ordering presupposes operations to order",
  },
  {
    level: 8,
    instrument: "brass",
    verdict: "unusual",
    rationale: "assertion at the level of pure philosophy is possible but rarely productive",
  },
];

/**
 * Returns the legality of a single (level, instrument) pair.
 * Defaults to `legal` for any pair not explicitly listed in RULES.
 */
export function pairLegality(
  level: Level,
  instrument: InstrumentType,
): Legality {
  for (const rule of RULES) {
    if (rule.level === level && rule.instrument === instrument) {
      return rule.verdict;
    }
  }
  return "legal";
}

/**
 * Looks up the human-readable rationale for a non-legal pair, or null
 * if the pair is `legal`. Useful when the validator or planner needs
 * to explain a rejection or penalty in a Performance log.
 */
export function pairRationale(
  level: Level,
  instrument: InstrumentType,
): string | null {
  for (const rule of RULES) {
    if (rule.level === level && rule.instrument === instrument) {
      return rule.rationale;
    }
  }
  return null;
}

/**
 * A beat is `illegal` if any of its voices is illegal at the beat's level,
 * `unusual` if at least one is unusual and none is illegal,
 * `legal` otherwise.
 */
export function beatLegality(
  level: Level,
  voices: readonly Voice[],
): Legality {
  let worst: Legality = "legal";
  for (const v of voices) {
    const l = pairLegality(level, v.instrument);
    if (l === "illegal") return "illegal";
    if (l === "unusual") worst = "unusual";
  }
  return worst;
}

/** Convenience boolean for the score validator's hard reject path. */
export function isLegalBeat(
  level: Level,
  voices: readonly Voice[],
): boolean {
  return beatLegality(level, voices) !== "illegal";
}
