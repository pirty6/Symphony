import type { Pattern } from "../../patterns";
import type { ExecutableScore, Performance, PerformedBeat } from "../../symphony/types";
import type { Pause } from "./pause";

export interface EngineConfig {
  readonly prompt: string;
  readonly patterns: readonly Pattern[];
  /** Optional clock injector used for startedAt. */
  readonly clock?: () => string;
  /** Optional pauseId generator. Defaults to crypto.randomUUID. Tests inject a deterministic factory. */
  readonly pauseIdFactory?: () => string;
}

export interface EngineResult {
  readonly executableScore: ExecutableScore;
  readonly performance: Performance;
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
}

type Running = "running";
type Done = "done";
type Failed = "failed";

type Kind = Running | Done | Failed;

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

type FailedState = EngineStateBase & {
  readonly kind: Failed;
  readonly error: string;
};

export type EngineState = RunningState | DoneState | FailedState;
