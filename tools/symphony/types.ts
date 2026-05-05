/**
 * types.ts — Core types for the Symphony spectral orchestrator.
 *
 * Symphony decomposes a problem into a static frequency spectrum
 * (FrequencyMap) and then plans a path through that spectrum
 * (ExecutableScore) which an orchestra of instrument-typed sub-agents
 * performs. The Performance is a separate artifact recording what
 * actually happened during execution.
 *
 * Design invariants (v1):
 *   1. Score and Performance are distinct artifacts. A Score is a plan;
 *      a Performance is a recording. SavedRun = (Score, Performance).
 *      Beat holds plan-only fields; PerformedBeat holds execution fields.
 *      This is intentionally stricter than earlier drafts where Beat
 *      carried verdict+stateHash directly — keeping them split is what
 *      makes deterministic replay coherent.
 *   2. Beats are monophonic-by-default but the schema admits chords
 *      from day one (Beat.voices: Voice[]). A length-1 voices array is
 *      a monophonic beat. Polyphony costs nothing in the schema.
 *   3. Score.schemaVersion and ProblemFingerprint.schemaVersion are
 *      independent. The Score format and the canonicalizer evolve on
 *      separate clocks.
 *   4. Beats are flat. Loops, branches, and dispatches are deferred to
 *      schemaVersion: 2. The field is reserved.
 */

// ── Abstraction Levels ─────────────────────────────────────────────
// 1 = most concrete (raw artifact), 8 = most abstract (first principles).
// The 1D scale is a v1 simplification; observed failures will tell us
// which hidden axes (granularity, specificity, determinism) need to
// surface as their own dimensions.

export type Level = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const LEVELS: readonly Level[] = [1, 2, 3, 4, 5, 6, 7, 8] as const;

// ── Instruments ────────────────────────────────────────────────────
// Five epistemic modes, not five tools. The instrument constrains the
// kind of cognitive work performed at a beat, not the implementation.

export type InstrumentType =
  | "strings" // structural / relational
  | "brass" // assertive / definitive
  | "woodwinds" // exploratory / questioning
  | "percussion" // ordering / timing
  | "piano"; // harmonic / integrative

export const INSTRUMENTS: readonly InstrumentType[] = [
  "strings",
  "brass",
  "woodwinds",
  "percussion",
  "piano",
] as const;

// ── Domain Key ─────────────────────────────────────────────────────
// Open string type. Examples: "typescript/react-refactor",
// "distributed-systems/consistency", "security/auth-boundary".
// The key tunes how levels and instruments resolve in vocabulary.

export type DomainKey = string;

// ── Problem Fingerprint ────────────────────────────────────────────
// Two hashes side by side. v1 canonicalizer is identity, so the two
// hashes are equal in v1. They diverge once a non-trivial canonicalizer
// ships. Replay matching uses canonicalHash; rawHash aids exact debug.

export interface ProblemFingerprint {
  readonly rawHash: string;
  readonly canonicalHash: string;
  /** Tracks the canonicalizer version, NOT the Score schema version. */
  readonly schemaVersion: 1;
}

// ── Frequency Map ──────────────────────────────────────────────────
// Static decomposition. "Which levels does this problem actively
// touch?" Catalog matching operates on this, not on Score.

export interface FrequencyMap {
  readonly key: DomainKey;
  /** Levels whose share of beats is at or above the activity threshold. */
  readonly activeLevels: readonly Level[];
}

/** Minimum share of beats a level needs to count as active. */
export const LEVEL_ACTIVITY_THRESHOLD = 0.3;

// ── Verdict ───────────────────────────────────────────────────────────

export type VerdictOutcome = "applied" | "failed" | "skipped";

export interface MoveVerdict {
  readonly outcome: VerdictOutcome;
  readonly confidence: number;
  readonly shouldTerminate: boolean;
  readonly reason: string;
}

// ── Plan side: Score / Beat / Voice ────────────────────────────────
// A Voice in a Beat is a planned cognitive role. It carries no output —
// outputs live on PerformedVoice.

export interface Voice {
  readonly instrument: InstrumentType;
}

export interface Beat {
  readonly level: Level;
  /** Length 1 for monophonic. Length >1 for chords (polyphony). */
  readonly voices: readonly Voice[];
  readonly directive: string;
}

export interface ExecutableScore {
  readonly schemaVersion: 1;
  /** Deterministic id: hash of (frequencyMap + beats + generatedFrom + pattern? + context?). */
  readonly id: string;
  /**
   * Derived from the beat histogram at compile time. Lives only on
   * ExecutableScore — PatternScore is a skeleton and has no frequency
   * profile of its own. Two compilations of the same pattern with
   * different complexity scaling could produce different FrequencyMaps.
   */
  readonly frequencyMap: FrequencyMap;
  readonly beats: readonly Beat[];
  readonly generatedAt: string;
  readonly generatedFrom: ProblemFingerprint;
  /**
   * Pattern provenance. Set when the Score was produced by `compileScore`
   * from a Pattern; omitted for hand-authored Scores produced via the
   * low-level `parseAlgorithm` fallback. Hashed into `id` only when present.
   */
  readonly pattern?: string;
  /**
   * Repo-specific context the compiler injected (target names, scope
   * qualifiers, contracts, etc.). Validated against the Pattern's
   * `requiredContext`. Hashed into `id` only when present.
   */
  readonly context?: Readonly<Record<string, unknown>>;
}

// ── Performance side: PerformedBeat / Performance ──────────────────
// A PerformedVoice is what a Voice produced when executed. A
// PerformedBeat is the recording of one Beat's full execution,
// including all its voices, the integrated verdict, and the
// environmental stateHash captured immediately after.

export interface PerformedVoice {
  readonly instrument: InstrumentType;
  readonly output: string;
  readonly confidence: number;
  /**
   * Sub-agent that produced this voice output. Optional for back-compat
   * with saved runs predating the field; required on new perform-beat
   * resolutions (enforced in tools/maestro/engine.ts).
   */
  readonly producedBy?: "maestro-assessor" | "maestro-executor";
}

export interface PerformedBeat {
  readonly beatIndex: number;
  readonly voices: readonly PerformedVoice[];
  /** undefined if the beat ran but produced no actionable verdict. */
  readonly verdict: MoveVerdict | undefined;
  readonly stateHash: string;
}

export type PerformanceOutcome = "success" | "partial" | "failed" | "in-progress";

export interface Performance {
  /** Foreign key into Score.id. */
  readonly scoreId: string;
  readonly beats: readonly PerformedBeat[];
  readonly startedAt: string;
  /** undefined while in-progress. */
  readonly completedAt: string | undefined;
  readonly outcome: PerformanceOutcome;
}

// ── Saved Run ──────────────────────────────────────────────────────
// One file per execution under tools/scores/store/<pattern>/. Append-only.
// `patternScore` is a snapshot taken at compile time: even if the
// pattern's TypeScript module is later edited, every old saved run
// still describes itself in full. That is what makes the store an
// audit log rather than a cache.

export interface SavedRun {
  readonly schemaVersion: 1;
  /** Snapshot of the static skeleton at compile time. */
  readonly patternScore: import("../patterns/types").PatternScore;
  /** The compiled, executable Score that was actually performed. */
  readonly executableScore: ExecutableScore;
  readonly performance: Performance;
  /** Mirrors executableScore.generatedFrom.canonicalHash for fast lookup. */
  readonly problemFingerprint: string;
  /** Mirrors executableScore.generatedAt for filename + sort. */
  readonly timestamp: string;
}

// ── Divergence Report ──────────────────────────────────────────────
// Four orthogonal signals. The "did this run reproduce" predicate is
//   !report.structural && report.semantic.length === 0
// Environmental drift is a warning (codebase changed underneath the
// replay). Prose drift is informational only.

export interface VerdictDelta {
  readonly beatIndex: number;
  readonly saved: MoveVerdict | undefined;
  readonly fresh: MoveVerdict | undefined;
}

export interface HashDelta {
  readonly beatIndex: number;
  readonly saved: string;
  readonly fresh: string;
}

export interface DivergenceReport {
  /** Beat count or beat-shape mismatch. Always a hard divergence. */
  readonly structural: boolean;
  /** Verdicts differ at specific beats. Hard divergence. */
  readonly semantic: readonly VerdictDelta[];
  /** stateHash differs at specific beats. Soft warning. */
  readonly environmental: readonly HashDelta[];
  /** Count of beats with differing voice prose. Informational. */
  readonly prose: number;
}

// ── Legality ───────────────────────────────────────────────────────
// Three-valued so the score validator can hard-reject `illegal`
// combinations while the score generator merely penalizes `unusual`
// ones during path planning. Demotion of `unusual` → `legal` should
// be data-driven from observed Performance success rates.

export type Legality = "legal" | "unusual" | "illegal";

// ── Fallback Condition ─────────────────────────────────────────────
// Named conditions under which Symphony refuses to generate a Score.
// The caller surfaces the condition to the user and re-iterates the
// algorithm in maestro phase 2 (there is no separate fallback CLI).

export type FallbackCondition =
  | { readonly reason: "no-active-levels"; readonly detail: string }
  | { readonly reason: "illegible-problem"; readonly detail: string }
  | { readonly reason: "pure-mechanical"; readonly detail: string }
  | { readonly reason: "schema-version-mismatch"; readonly detail: string };
