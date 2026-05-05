/**
 * types.ts — Core types for the Symphony spectral orchestrator.
 *
 * Symphony is a parallel framework to meta-score. Where meta-score is a
 * sequential phase machine, Symphony decomposes a problem into a static
 * frequency spectrum (FrequencyMap) and then plans a path through that
 * spectrum (Score) which an orchestra of instrument-typed sub-agents
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

// ── Tempo ──────────────────────────────────────────────────────────

export type Conservatism = "aggressive" | "balanced" | "conservative";

export interface TempoConfig {
  readonly conservatism: Conservatism;
  /** Verification cadence: how many beats per gated checkpoint. */
  readonly beatsPerMeasure: number;
}

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
// Static decomposition. "What levels does this problem contain, and
// at what amplitude?" Catalog matching operates on this, not on Score.

export type Shape =
  | "localized"
  | "layered"
  | "architectural"
  | "philosophical";

export interface FrequencyMap {
  /** Amplitude in [0, 1] at each level. All 8 keys present. */
  readonly levels: Readonly<Record<Level, number>>;
  /** Levels whose amplitude is at or above the dominance threshold. */
  readonly dominantLevels: readonly Level[];
  readonly shape: Shape;
  readonly key: DomainKey;
}

/** Default amplitude threshold for `dominantLevels` membership. */
export const DOMINANCE_THRESHOLD = 0.3;

// ── Verdict (mirrors symphony-core MoveVerdict at the boundary) ────

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

export interface Score {
  readonly schemaVersion: 1;
  /** Deterministic id: hash of (frequencyMap + tempo + generatedFrom). */
  readonly id: string;
  readonly frequencyMap: FrequencyMap;
  readonly tempo: TempoConfig;
  readonly beats: readonly Beat[];
  readonly generatedAt: string;
  readonly generatedFrom: ProblemFingerprint;
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
}

export interface PerformedBeat {
  readonly beatIndex: number;
  readonly voices: readonly PerformedVoice[];
  /** null if the beat ran but produced no actionable verdict. */
  readonly verdict: MoveVerdict | null;
  readonly stateHash: string;
}

export type PerformanceOutcome =
  | "success"
  | "partial"
  | "failed"
  | "in-progress";

export interface Performance {
  /** Foreign key into Score.id. */
  readonly scoreId: string;
  readonly beats: readonly PerformedBeat[];
  readonly startedAt: string;
  /** null while in-progress. */
  readonly completedAt: string | null;
  readonly outcome: PerformanceOutcome;
}

// ── Saved Run ──────────────────────────────────────────────────────

export interface SavedRun {
  readonly score: Score;
  readonly performance: Performance;
}

// ── Divergence Report ──────────────────────────────────────────────
// Four orthogonal signals. The "did this run reproduce" predicate is
//   !report.structural && report.semantic.length === 0
// Environmental drift is a warning (codebase changed underneath the
// replay). Prose drift is informational only.

export interface VerdictDelta {
  readonly beatIndex: number;
  readonly saved: MoveVerdict | null;
  readonly fresh: MoveVerdict | null;
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
// Named conditions under which Symphony refuses to generate a Score
// and the caller should fall back to the meta-score phase machine
// (or to direct execution, in the case of `pure-mechanical`).

export type FallbackCondition =
  | { readonly reason: "no-dominant-levels"; readonly detail: string }
  | { readonly reason: "illegible-problem"; readonly detail: string }
  | { readonly reason: "pure-mechanical"; readonly detail: string }
  | { readonly reason: "schema-version-mismatch"; readonly detail: string };
