/**
 * event.ts — Typed event system for the Maestro engine.
 *
 * Events are return values from `createEngine()` and `advance()`, not
 * side effects. The engine remains a pure reducer; events capture what
 * happened during each transition so callers can drive visualizers,
 * structured logging, and CI integrations without parsing engine state.
 *
 * Every event is a member of the `MaestroEvent` discriminated union
 * (discriminant: `kind`). Events are emitted in chronological order
 * within a single `advance()` call.
 */

import type { KindType } from "./kind";
import type { Complexity } from "./types";
import type { VerdictOutcome } from "../../symphony/types";

// ── Event types ─────────────────────────────────────────────────────

/** Emitted once by `createEngine()` at the start of every run. */
export interface RunStartedEvent {
  readonly kind: "run-started";
  readonly prompt: string;
  readonly pattern: string;
}

/** Emitted whenever a new Pause is produced (any pause kind). */
export interface PauseEmittedEvent {
  readonly kind: "pause-emitted";
  readonly pauseKind: KindType;
  readonly pauseId: string;
}

/** Emitted when confirm-fit resolves with `ok: true`. */
export interface PatternConfirmedEvent {
  readonly kind: "pattern-confirmed";
  readonly pattern: string;
}

/** Emitted when confirm-fit resolves with `ok: false` and a reroute target. */
export interface PatternReroutedEvent {
  readonly kind: "pattern-rerouted";
  readonly from: string;
  readonly to: string;
}

/** Emitted when classify-complexity resolves. */
export interface ComplexityClassifiedEvent {
  readonly kind: "complexity-classified";
  readonly complexity: Complexity;
}

/** Emitted when a draft-pattern-round resolves (approve, edit, or ambiguous). */
export interface DraftRoundCompletedEvent {
  readonly kind: "draft-round-completed";
  readonly round: number;
  readonly outcome: "approve" | "edit" | "ambiguous";
}

/** Emitted when elicit-context resolves with values (even if some are still missing). */
export interface ContextCollectedEvent {
  readonly kind: "context-collected";
  readonly keys: readonly string[];
  readonly missingKeys: readonly string[];
}

/** Emitted when the go-gate compiles a Score (non-planOnly mode). */
export interface ScoreCompiledEvent {
  readonly kind: "score-compiled";
  readonly scoreId: string;
  readonly beatCount: number;
}

/** Emitted when a perform-beat Pause is produced (before execution). */
export interface BeatStartedEvent {
  readonly kind: "beat-started";
  readonly beatIndex: number;
  readonly directive: string;
}

/** Emitted when a perform-beat resolution is accepted (after execution). */
export interface BeatCompletedEvent {
  readonly kind: "beat-completed";
  readonly beatIndex: number;
  readonly verdictOutcome: VerdictOutcome;
  readonly confidence: number;
}

/** Emitted when the engine reaches the `done` terminal state. */
export interface RunCompletedEvent {
  readonly kind: "run-completed";
  readonly outcome: string;
  readonly beatCount: number;
}

/** Emitted when the engine reaches the `failed` terminal state. */
export interface RunFailedEvent {
  readonly kind: "run-failed";
  readonly error: string;
}

/** Emitted when the engine reaches the `planned` terminal state (planOnly mode). */
export interface RunPlannedEvent {
  readonly kind: "run-planned";
  readonly outPath?: string;
}

// ── Discriminated union ─────────────────────────────────────────────

export type MaestroEvent =
  | RunStartedEvent
  | PauseEmittedEvent
  | PatternConfirmedEvent
  | PatternReroutedEvent
  | ComplexityClassifiedEvent
  | DraftRoundCompletedEvent
  | ContextCollectedEvent
  | ScoreCompiledEvent
  | BeatStartedEvent
  | BeatCompletedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunPlannedEvent;
