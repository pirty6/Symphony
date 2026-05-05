/**
 * heuristic.ts — Mechanical baseline FrequencyMap producer (Option C).
 *
 * The heuristic exists to be *beaten*. It is a deliberately dumb,
 * deterministic, keyword-driven decomposer whose only job is to give
 * the human-authored maps something to cross-check against. Where the
 * heuristic and the human agree, confidence is high. Where they diverge,
 * the divergence itself is the data.
 *
 * Discipline:
 *   - No example problems were consulted while authoring the rules below.
 *     Rules come from general problem-domain reasoning (file count,
 *     scope words, abstraction keywords) so the cross-check stays clean.
 *   - The heuristic must not be tuned against the 10 hand-encoded
 *     examples after the fact. If it disagrees with an example, that
 *     is a finding, not a bug.
 *   - Any rule added later must be motivated by observed failure on a
 *     real problem, not by aesthetic improvement.
 */

import {
  DOMINANCE_THRESHOLD,
  type DomainKey,
  type FrequencyMap,
  type Level,
  LEVELS,
  type Shape,
} from "./types";

interface KeywordRule {
  readonly pattern: RegExp;
  readonly level: Level;
  readonly weight: number;
}

// Pattern → level contribution. Patterns are case-insensitive. Multiple
// matches stack additively, then the whole vector is normalized into [0,1].
const RULES: readonly KeywordRule[] = [
  // Level 1 — raw artifact
  { pattern: /\b(typo|rename|line\s+\d+|this\s+line)\b/i, level: 1, weight: 1.0 },
  { pattern: /\b(single\s+(file|line|symbol)|one-?liner)\b/i, level: 1, weight: 0.8 },

  // Level 2 — local pattern
  { pattern: /\b(function|method|smell|local|helper)\b/i, level: 2, weight: 0.5 },
  { pattern: /\b(extract|inline|rename\s+function)\b/i, level: 2, weight: 0.7 },

  // Level 3 — module behavior
  { pattern: /\b(module|component|class\s+behavior|behavior\s+of)\b/i, level: 3, weight: 0.6 },
  { pattern: /\b(unit\s+test|behavior|responsibility)\b/i, level: 3, weight: 0.4 },

  // Level 4 — system contract
  { pattern: /\b(api|interface|contract|boundary|seam)\b/i, level: 4, weight: 0.6 },
  { pattern: /\b(integration|protocol|schema)\b/i, level: 4, weight: 0.5 },

  // Level 5 — architectural
  { pattern: /\b(architecture|architectural|system\s+design|coupling)\b/i, level: 5, weight: 0.8 },
  { pattern: /\b(refactor\s+across|cross-cutting|layer)\b/i, level: 5, weight: 0.5 },

  // Level 6 — domain model
  { pattern: /\b(domain|model|ontology|invariants?)\b/i, level: 6, weight: 0.6 },

  // Level 7 — design philosophy
  { pattern: /\b(philosophy|why\s+is\s+it\s+shaped|design\s+rationale|trade-?offs?)\b/i, level: 7, weight: 0.7 },

  // Level 8 — first principles
  { pattern: /\b(first\s+principles?|fundamental|class\s+of\s+(systems|problems))\b/i, level: 8, weight: 0.9 },
];

function emptyAmplitudes(): Record<Level, number> {
  const out = {} as Record<Level, number>;
  for (const lvl of LEVELS) out[lvl] = 0;
  return out;
}

function normalize(raw: Record<Level, number>): Record<Level, number> {
  let max = 0;
  for (const lvl of LEVELS) if (raw[lvl] > max) max = raw[lvl];
  if (max === 0) return raw;
  const out = {} as Record<Level, number>;
  for (const lvl of LEVELS) out[lvl] = raw[lvl] / max;
  return out;
}

function computeShape(levels: Record<Level, number>): Shape {
  // Crude classifier: which range carries the most amplitude?
  const low = levels[1] + levels[2];
  const mid = levels[3] + levels[4] + levels[5];
  const high = levels[6] + levels[7] + levels[8];
  const top = Math.max(low, mid, high);
  if (top === 0) return "localized";
  if (low === top) return "localized";
  if (mid === top) return high > low ? "architectural" : "layered";
  // high === top
  return levels[7] + levels[8] > levels[6] ? "philosophical" : "architectural";
}

function dominantLevels(levels: Record<Level, number>): Level[] {
  const out: Level[] = [];
  for (const lvl of LEVELS) {
    if (levels[lvl] >= DOMINANCE_THRESHOLD) out.push(lvl);
  }
  return out;
}

/**
 * Produce a FrequencyMap from a problem statement using only mechanical
 * keyword rules. No LLM call. Deterministic for a given input.
 */
export function heuristicFrequencyMap(
  problemStatement: string,
  key: DomainKey,
): FrequencyMap {
  const raw = emptyAmplitudes();
  for (const rule of RULES) {
    const matches = problemStatement.match(new RegExp(rule.pattern, "gi"));
    if (matches) raw[rule.level] += rule.weight * matches.length;
  }
  const levels = normalize(raw);
  return {
    levels,
    dominantLevels: dominantLevels(levels),
    shape: computeShape(levels),
    key,
  };
}
