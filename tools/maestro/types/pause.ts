import type { Pattern } from "../../patterns/types";
import type { Beat } from "../../symphony/types";
import type {
  ClassifyComplexity,
  ConfirmFit,
  DraftPatternRound,
  ElicitContext,
  GoGate,
  KindType,
  MatchPattern,
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
  readonly matchedVerb: string;
}

type MatchPatternPause = BasePause & {
  readonly kind: MatchPattern;
  readonly payload: {
    readonly prompt: string;
    readonly candidates: readonly PatternSummary[];
  };
};

type ConfirmFitPattern = BasePause & {
  readonly kind: ConfirmFit;
  readonly payload: {
    readonly pattern: string;
    readonly matchedVerb: string;
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
    readonly complexity: Complexity;
    readonly priorDraft: Pattern | null;
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
    readonly previousOutputs: readonly string[];
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
  | MatchPatternPause
  | ConfirmFitPattern
  | ClassifyComplexityPause
  | DraftPatternRoundPause
  | ElicitContextPause
  | GoGatePause
  | PerformBeatPause;
