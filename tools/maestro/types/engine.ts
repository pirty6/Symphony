import type { Pattern, PatternScore } from "../../patterns";
import type { AlgorithmInput } from "../../compiler/compile";
import type { ExecutableScore, Performance, PerformedBeat } from "../../symphony/types";
import type { Pause } from "./pause";
import type { MaestroEvent } from "./event";

export interface EngineConfig {
  readonly prompt: string;
  readonly patterns: readonly Pattern[];
  /**
   * Pre-engine routing decision. Either a registered pattern name (engine
   * begins at `confirm-fit`) or the literal string `"new"` (engine begins
   * at `classify-complexity` to draft a fresh pattern). The agent picks
   * this by reading `symphony list-patterns --json` before invoking the
   * engine; the engine itself does not route.
   */
  readonly pattern: string;
  /**
   * When `true`, the engine stops at the go-gate and emits an
   * `AlgorithmInput` instead of compiling a Score and entering the
   * perform-beat phase. The handoff is finished by `symphony parse` +
   * `symphony perform`. Used by the `maestro plan` subcommand.
   */
  readonly planOnly?: boolean;
  /**
   * Filesystem path the CLI will write the emitted `AlgorithmInput`
   * to when the engine reaches `planned`. Plumbed through state so a
   * single `--out` on `maestro plan` survives the multi-turn
   * `start`→`resolve` round-trip without re-supplying it.
   */
  readonly outPath?: string;
  /** Optional clock injector used for startedAt. */
  readonly clock?: () => string;
  /** Optional pauseId generator. Defaults to crypto.randomUUID. Tests inject a deterministic factory. */
  readonly pauseIdFactory?: () => string;
}

export interface EngineResult {
  readonly executableScore: ExecutableScore;
  readonly performance: Performance;
  /** Snapshot of the pattern skeleton used to compile the score. */
  readonly patternScore: PatternScore;
}

export interface InternalState {
  readonly prompt: string;
  /** Static + drafted patterns, all carried as data. */
  readonly patterns: readonly Pattern[];
  /** Active pattern is referenced by name; resolve via patterns[]. */
  readonly active: { readonly patternName: string } | undefined;
  readonly context: Readonly<Record<string, string>>;
  readonly draftRound: number;
  readonly score: ExecutableScore | undefined;
  readonly performedBeats: readonly PerformedBeat[];
  readonly startedAt: string;
  /**
   * Mirror of `EngineConfig.planOnly`. Persisted in state so the
   * decision survives the `start`→`resolve` round-trip.
   */
  readonly planOnly: boolean;
  /** Mirror of `EngineConfig.outPath`. Only meaningful when `planOnly`. */
  readonly outPath?: string;
}

type Running = "running";
type Done = "done";
type Planned = "planned";
type Failed = "failed";

type Kind = Running | Done | Planned | Failed;

type EngineStateBase = {
  readonly kind: Kind;
};

type RunningState = EngineStateBase & {
  readonly kind: Running;
  readonly pause: Pause;
  readonly internal: InternalState;
};

type DoneState = EngineStateBase & {
  readonly kind: Done;
  readonly result: EngineResult;
};

/**
 * Terminal state reached when the engine was started with
 * `planOnly: true` and the user said "go" at the go-gate. The
 * `algorithm` is the handoff artifact for `symphony parse`, and
 * `outPath` is the file path the CLI will write it to.
 */
type PlannedState = EngineStateBase & {
  readonly kind: Planned;
  readonly algorithm: AlgorithmInput;
  readonly outPath?: string;
};

type FailedState = EngineStateBase & {
  readonly kind: Failed;
  readonly error: string;
};

/**
 * Return type of `createEngine()` and `advance()`. The engine state is
 * augmented with the events emitted during the transition. Events are
 * return values, not side effects — the engine remains pure.
 *
 * The intersection preserves discriminated-union narrowing on `kind`:
 * existing code that checks `result.kind === "running"` continues to
 * work and gains access to `result.events`.
 */
export type AdvanceResult = EngineState & { readonly events: readonly MaestroEvent[] };

export type EngineState = RunningState | DoneState | PlannedState | FailedState;
