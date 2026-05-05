/**
 * types.ts — Types for the curated PatternLibrary.
 *
 * Two layers:
 *
 *   PatternScore   — static skeleton. Pattern owns it. Reusable across
 *                    any problem matching the pattern's verb-triggers.
 *                    Beats are declared once; directives are static prose
 *                    colocated with the beat definition. No frequencyMap.
 *
 *   ExecutableScore — per-problem executable artifact, produced by the
 *                    compiler from a PatternScore + concrete context.
 *                    Lives in tools/symphony/types.ts. Carries the
 *                    derived FrequencyMap. Hashed and saved.
 *
 * The Pattern declares which keys it expects in the context object via
 * `requiredContext`. The compiler validates context against that list.
 * Repo-specific knobs (target names, scope qualifiers, contract text)
 * flow through context, NOT through directive interpolation. Static
 * directives keep the skeleton truly reusable.
 */

import type {
  DomainKey,
  InstrumentType,
  Level,
} from "../symphony/types";

/**
 * One beat of a Pattern's static skeleton.
 *
 * `step` is a stable identifier (e.g., "clarify-restate", "scope").
 * `directive` is canonical prose authored once per pattern; the compiler
 * copies it verbatim into the executable Score's beats. Repo-specific
 * detail flows through the Score's `context` field, not via interpolation.
 */
export interface PatternBeat {
  readonly step: string;
  readonly level: Level;
  readonly instrument: InstrumentType;
  readonly directive: string;
}

/**
 * The static, reusable skeleton owned by a Pattern.
 *
 * "Score per pattern, not per problem": this is the per-pattern half.
 * The per-problem half is `ExecutableScore` (in tools/symphony/types.ts),
 * produced by `compileScore` per invocation.
 *
 * Note the deliberate omission of `frequencyMap`: a pattern is a
 * skeleton, not a frequency profile. The FrequencyMap is *derived*
 * from the beat histogram of a specific compilation and lives only
 * on `ExecutableScore`. Two compilations of the same pattern with
 * different complexity scaling could produce different FrequencyMaps;
 * keeping the field off PatternScore prevents that asymmetry from
 * leaking back into the static layer.
 */
export interface PatternScore {
  readonly pattern: string;
  readonly domain: DomainKey;
  readonly beats: readonly PatternBeat[];
}

/**
 * A reusable algorithm template.
 *
 * `score` is the static skeleton. `verbTriggers` and `requiredContext`
 * are routing metadata: the phrases maestro scans for at pattern-pick
 * time, and the repo-specific keys the compiler refuses to compile
 * without. Both are owned by the Pattern, not by the PatternScore —
 * a PatternScore is the algorithm's shape, not its routing rules.
 *
 * Missing required keys halt compilation — that is how the v1 "no
 * target → halt and route to investigate" rule for refactor is now
 * expressed.
 */
export interface Pattern {
  readonly score: PatternScore;
  /** Phrases the maestro Setup phase scans for at routing time. */
  readonly verbTriggers: readonly string[];
  /** Keys that must be present in the ExecutableScore's `context` field. */
  readonly requiredContext: readonly string[];
}
