import type { Pattern } from "../../patterns/types";
import type { Beat, VerdictOutcome } from "../../symphony/types";
import type {
  ClassifyComplexity,
  ConfirmFit,
  DraftPatternRound,
  ElicitContext,
  GoGate,
  KindType,
  PerformBeat,
} from "./kind";
import type { Complexity } from "./types";

interface BasePause {
  readonly kind: KindType;
  readonly pauseId: string;
  readonly payload: {};
  readonly composerPrompt: string;
  readonly instrumentPrompt: string;
}

export interface PatternSummary {
  readonly pattern: string;
  readonly description: string;
}

/**
 * Provenance-rich record of an earlier beat made available to the
 * next perform-beat pause. Replaces the prior flat-string join so
 * that a downstream beat sees beat index, directive, per-voice
 * instrument labels, and the recorded verdict outcome.
 */
export interface PreviousBeatOutput {
  readonly beatIndex: number;
  readonly directive: string;
  readonly voices: readonly {
    readonly instrument: string;
    readonly output: string;
  }[];
  readonly verdictOutcome: VerdictOutcome;
}

type ConfirmFitPattern = BasePause & {
  readonly kind: ConfirmFit;
  readonly payload: {
    readonly pattern: string;
    readonly description: string;
  };
};

type ClassifyComplexityPause = BasePause & {
  readonly kind: ClassifyComplexity;
  readonly payload: {
    readonly prompt: string;
  };
};

type DraftPatternRoundPause = BasePause & {
  readonly kind: DraftPatternRound;
  readonly payload: {
    readonly round: number;
    readonly maxRounds: number;
    /** Effective complexity for this round (may be escalated above baseHint). */
    readonly complexity: Complexity;
    /** Original tier from classify-complexity; used to escalate on subsequent rounds. */
    readonly baseHint: Complexity;
    readonly priorDraft: Pattern | undefined;
  };
};

type ElicitContextPause = BasePause & {
  readonly kind: ElicitContext;
  readonly payload: {
    readonly pattern: string;
    readonly missingKeys: readonly string[];
    readonly collected: Readonly<Record<string, string>>;
  };
};

type GoGatePause = BasePause & {
  readonly kind: GoGate;
  readonly payload: {
    readonly pattern: string;
    readonly context: Readonly<Record<string, string>>;
    readonly beats: number;
  };
};

type PerformBeatPause = BasePause & {
  readonly kind: PerformBeat;
  readonly payload: {
    readonly beatIndex: number;
    readonly beat: Beat;
    readonly previousOutputs: readonly PreviousBeatOutput[];
  };
};

/**
 * Every Pause carries a unique opaque token. The next Resolution must
 * echo it back — if it does not, advance() rejects the call. This makes
 * advance() idempotent: re-submitting the same Resolution against an
 * already-consumed state is no longer silently accepted as a fresh
 * transition.
 */
export type Pause =
  | ConfirmFitPattern
  | ClassifyComplexityPause
  | DraftPatternRoundPause
  | ElicitContextPause
  | GoGatePause
  | PerformBeatPause;
