import type { Pattern } from "../../patterns";
import type { MoveVerdict } from "../../symphony/types";
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
import type { Complexity, VoiceProducer } from "./types";

interface ResolutionBase {
  readonly kind: KindType;
  readonly pauseId: string;
}

type MatchPatternResolution = ResolutionBase & {
  readonly kind: MatchPattern;
  readonly chosen: string | "no-match";
};

type ElicitContextResolution = ResolutionBase & {
  readonly kind: ElicitContext;
  readonly values: Readonly<Record<string, string>>;
};

type ConfirmFitResolution = ResolutionBase & {
  readonly kind: ConfirmFit;
  readonly ok: boolean;
  readonly reroute?: string;
};

type DraftPatternRoundResolution = ResolutionBase & {
  readonly kind: DraftPatternRound;
  readonly outcome: "approve" | "edit" | "ambiguous";
  readonly nextDraft?: Pattern;
};

type ClassifyComplexityResolution = ResolutionBase & {
  readonly kind: ClassifyComplexity;
  readonly complexity: Complexity;
};

type GoGateResolution = ResolutionBase & {
  readonly kind: GoGate;
  readonly phrase: string;
};

type PerformBeatResolution = ResolutionBase & {
  readonly kind: PerformBeat;
  readonly voiceOutputs: readonly {
    readonly instrument: string;
    readonly output: string;
    readonly confidence: number;
    readonly producedBy: VoiceProducer;
  }[];
  readonly verdict: MoveVerdict;
};

/**
 * Every Resolution carries the pauseId of the Pause it answers. The
 * engine rejects any Resolution whose pauseId does not match the
 * current running state's pauseId — including resubmissions of the
 * same Resolution after the state has already advanced.
 */
export type Resolution =
  | MatchPatternResolution
  | ConfirmFitResolution
  | ElicitContextResolution
  | ClassifyComplexityResolution
  | DraftPatternRoundResolution
  | GoGateResolution
  | PerformBeatResolution;
