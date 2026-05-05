/**
 * engine.ts — Maestro state machine.
 *
 * Pure reducer. createEngine + advance. No fs, no LLM, no network.
 * Caller drives the loop and supplies a Resolution at every Pause.
 *
 * The state machine encodes the three phases of
 * `.github/agents/maestro.agent.md` such that every gate the
 * markdown previously asked the LLM to honor is enforced in code:
 *
 *   - verb-match routing               (deterministic from Pattern.verbTriggers)
 *   - elicit-context non-empty         (re-emits while any required key blank)
 *   - go-gate canonical phrases only   (vague positive language rejected)
 *   - draft-pattern MAX_ROUNDS=6       (terminal failure on round 7)
 *   - perform-beat shape validation    (the footnote-bug guard)
 *
 * EngineState is JSON-round-trippable: callers may persist a state
 * object between turns and resume by passing it back to advance().
 * Patterns travel inside the state as data; no function values, no
 * object identity. The optional clock injector is a parameter to
 * createEngine/advance, never embedded in state.
 */

import * as crypto from "node:crypto";

import type { Pattern } from "../patterns/types";
import type {
  Beat,
  ExecutableScore,
  MoveVerdict,
  Performance,
  PerformedBeat,
  PerformedVoice,
} from "../symphony/types";
import { compileScore } from "../compiler/compile";
import { scaffoldPerformance } from "../symphony/perform";

// ── Public types ────────────────────────────────────────────────────

export const MAESTRO_GO_PHRASES = [
  "go",
  "approved",
  "looks good",
  "ship it",
  "proceed",
] as const;

export const MAESTRO_DRAFT_MAX_ROUNDS = 6;

export type DebateComplexity = 1 | 2 | 3 | 4;

export interface PatternSummary {
  readonly pattern: string;
  readonly matchedVerb: string;
}

export type Pause =
  | {
      readonly kind: "match-pattern";
      readonly payload: {
        readonly prompt: string;
        readonly candidates: readonly PatternSummary[];
      };
      readonly composerPrompt: string;
      readonly instrumentPrompt: string;
    }
  | {
      readonly kind: "confirm-fit";
      readonly payload: { readonly pattern: string; readonly matchedVerb: string };
      readonly composerPrompt: string;
      readonly instrumentPrompt: string;
    }
  | {
      readonly kind: "draft-pattern-round";
      readonly payload: {
        readonly round: number;
        readonly maxRounds: number;
        readonly debateComplexity: DebateComplexity;
        readonly priorDraft: Pattern | null;
      };
      readonly composerPrompt: string;
      readonly instrumentPrompt: string;
    }
  | {
      readonly kind: "elicit-context";
      readonly payload: {
        readonly pattern: string;
        readonly missingKeys: readonly string[];
        readonly collected: Readonly<Record<string, string>>;
      };
      readonly composerPrompt: string;
      readonly instrumentPrompt: string;
    }
  | {
      readonly kind: "go-gate";
      readonly payload: {
        readonly pattern: string;
        readonly context: Readonly<Record<string, string>>;
        readonly beats: number;
      };
      readonly composerPrompt: string;
      readonly instrumentPrompt: string;
    }
  | {
      readonly kind: "perform-beat";
      readonly payload: {
        readonly beatIndex: number;
        readonly beat: Beat;
        readonly previousOutputs: readonly string[];
      };
      readonly composerPrompt: string;
      readonly instrumentPrompt: string;
    };

export type Resolution =
  | { readonly kind: "match-pattern"; readonly chosen: string | "no-match" }
  | { readonly kind: "confirm-fit"; readonly ok: boolean; readonly reroute?: string }
  | {
      readonly kind: "draft-pattern-round";
      readonly outcome: "approve" | "edit" | "ambiguous";
      readonly nextDraft?: Pattern;
    }
  | {
      readonly kind: "elicit-context";
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly kind: "go-gate"; readonly phrase: string }
  | {
      readonly kind: "perform-beat";
      readonly voiceOutputs: readonly {
        readonly instrument: string;
        readonly output: string;
        readonly confidence: number;
      }[];
      readonly verdict: MoveVerdict;
    };

export interface EngineConfig {
  readonly prompt: string;
  readonly patterns: readonly Pattern[];
  /** Optional initial complexity classification for draft-pattern. Defaults to 2. */
  readonly debateComplexityHint?: DebateComplexity;
  /** Optional clock injector used for startedAt. */
  readonly clock?: () => string;
}

export interface EngineResult {
  readonly executableScore: ExecutableScore;
  readonly performance: Performance;
}

export type EngineState =
  | {
      readonly kind: "running";
      readonly pause: Pause;
      readonly internal: InternalState;
    }
  | { readonly kind: "done"; readonly result: EngineResult }
  | { readonly kind: "failed"; readonly error: string };

// ── Internal state (data-only; JSON-round-trippable) ───────────────

export interface InternalState {
  readonly prompt: string;
  /** Static + drafted patterns, all carried as data. */
  readonly patterns: readonly Pattern[];
  /** Active pattern is referenced by name; resolve via patterns[]. */
  readonly active: { readonly patternName: string; readonly matchedVerb: string } | null;
  readonly context: Readonly<Record<string, string>>;
  readonly draftRound: number;
  readonly debateComplexityHint: DebateComplexity;
  readonly score: ExecutableScore | null;
  readonly performedBeats: readonly PerformedBeat[];
  readonly startedAt: string;
}

// ── Factory ────────────────────────────────────────────────────────

export function createEngine(config: EngineConfig): EngineState {
  const clock = config.clock ?? defaultClock;
  const prompt = config.prompt;
  const candidates = matchVerbs(prompt, config.patterns);

  const internal: InternalState = {
    prompt,
    patterns: config.patterns,
    active: null,
    context: {},
    draftRound: 0,
    debateComplexityHint: config.debateComplexityHint ?? 2,
    score: null,
    performedBeats: [],
    startedAt: clock(),
  };

  if (candidates.length === 1) {
    return enterConfirmFit(internal, candidates[0]);
  }
  if (candidates.length > 1) {
    return runningPause(internal, makeMatchPatternPause(prompt, candidates));
  }
  return enterDraftPatternRound(internal, 1, null);
}

// ── Reducer ────────────────────────────────────────────────────────

export interface AdvanceOptions {
  readonly clock?: () => string;
}

export function advance(
  state: EngineState,
  resolution: Resolution,
  opts: AdvanceOptions = {},
): EngineState {
  if (state.kind !== "running") return state;
  const pause = state.pause;
  const internal = state.internal;
  const clock = opts.clock ?? defaultClock;

  if (pause.kind !== resolution.kind) {
    return failed(
      `resolution kind '${resolution.kind}' does not match pause '${pause.kind}'`,
    );
  }

  switch (pause.kind) {
    case "match-pattern":
      return resolveMatchPattern(internal, resolution as MatchRes);
    case "confirm-fit":
      return resolveConfirmFit(internal, resolution as ConfirmRes);
    case "draft-pattern-round":
      return resolveDraftRound(internal, resolution as DraftRes, pause);
    case "elicit-context":
      return resolveElicitContext(internal, resolution as ElicitRes);
    case "go-gate":
      return resolveGoGate(internal, resolution as GoRes, clock);
    case "perform-beat":
      return resolvePerformBeat(internal, resolution as PerformRes, pause, clock);
  }
}

// ── Phase 1 transitions ────────────────────────────────────────────

type MatchRes = Extract<Resolution, { kind: "match-pattern" }>;
type ConfirmRes = Extract<Resolution, { kind: "confirm-fit" }>;
type DraftRes = Extract<Resolution, { kind: "draft-pattern-round" }>;
type ElicitRes = Extract<Resolution, { kind: "elicit-context" }>;
type GoRes = Extract<Resolution, { kind: "go-gate" }>;
type PerformRes = Extract<Resolution, { kind: "perform-beat" }>;

function resolveMatchPattern(internal: InternalState, res: MatchRes): EngineState {
  if (res.chosen === "no-match") {
    return enterDraftPatternRound(internal, 1, null);
  }
  const target = findPattern(internal.patterns, res.chosen);
  if (!target) {
    return failed(`match-pattern: chosen '${res.chosen}' not registered`);
  }
  return enterConfirmFit(internal, {
    pattern: target.score.pattern,
    matchedVerb: bestVerbFor(internal.prompt, target) ?? "(chosen)",
  });
}

function resolveConfirmFit(internal: InternalState, res: ConfirmRes): EngineState {
  if (res.ok) {
    return enterAfterConfirmFit(internal);
  }
  // ok=false with reroute → fresh confirm-fit on the new pattern.
  if (res.reroute) {
    const target = findPattern(internal.patterns, res.reroute);
    if (!target) {
      return failed(`confirm-fit: reroute target '${res.reroute}' not registered`);
    }
    const cleared: InternalState = { ...internal, active: null, context: {} };
    return enterConfirmFit(cleared, {
      pattern: target.score.pattern,
      matchedVerb: bestVerbFor(internal.prompt, target) ?? "(rerouted)",
    });
  }
  // ok=false without reroute → user said wrong pattern but doesn't yet
  // know which one. Re-emit match-pattern with all registered patterns
  // as candidates so they can pick (or 'no-match' to draft).
  const all: readonly PatternSummary[] = internal.patterns.map((p) => ({
    pattern: p.score.pattern,
    matchedVerb: bestVerbFor(internal.prompt, p) ?? "(any)",
  }));
  const cleared: InternalState = { ...internal, active: null, context: {} };
  return runningPause(cleared, makeMatchPatternPause(internal.prompt, all));
}

function resolveDraftRound(
  internal: InternalState,
  res: DraftRes,
  pause: Extract<Pause, { kind: "draft-pattern-round" }>,
): EngineState {
  if (res.outcome === "approve") {
    if (!res.nextDraft) {
      return failed("draft-pattern-round: approve requires nextDraft");
    }
    const draft = res.nextDraft;
    // Add the approved draft to the registry and treat it as active.
    // Skip confirm-fit because the user just designed it.
    const augmentedPatterns = [...internal.patterns, draft];
    return enterAfterConfirmFit({
      ...internal,
      patterns: augmentedPatterns,
      active: { patternName: draft.score.pattern, matchedVerb: "(drafted)" },
      context: {},
    });
  }
  // edit / ambiguous → next round (cap enforced in code).
  const next = pause.payload.round + 1;
  if (next > MAESTRO_DRAFT_MAX_ROUNDS) {
    return failed(
      `draft-pattern: MAX_ROUNDS=${MAESTRO_DRAFT_MAX_ROUNDS} exceeded`,
    );
  }
  return enterDraftPatternRound(
    internal,
    next,
    res.nextDraft ?? pause.payload.priorDraft,
  );
}

// ── Phase 2 transitions ────────────────────────────────────────────

function resolveElicitContext(
  internal: InternalState,
  res: ElicitRes,
): EngineState {
  if (!internal.active) return failed("elicit-context: no active pattern");
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) return failed("elicit-context: active pattern not registered");
  const required = activePattern.requiredContext;
  const merged: Record<string, string> = { ...internal.context };
  for (const key of required) {
    const v = res.values[key];
    if (typeof v === "string" && v.trim() !== "") {
      merged[key] = v.trim();
    }
  }
  const missing = required.filter((k) => !merged[k]);
  const next: InternalState = { ...internal, context: merged };
  if (missing.length > 0) {
    return runningPause(next, makeElicitPause(activePattern, merged, missing));
  }
  return enterGoGate(next);
}

function resolveGoGate(
  internal: InternalState,
  res: GoRes,
  clock: () => string,
): EngineState {
  if (!internal.active) return failed("go-gate: no active pattern");
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) return failed("go-gate: active pattern not registered");
  const phrase = res.phrase.trim().toLowerCase();
  if (!(MAESTRO_GO_PHRASES as readonly string[]).includes(phrase)) {
    return runningPause(internal, makeGoGatePause(activePattern, internal.context));
  }
  let score: ExecutableScore;
  try {
    score = compileScore(activePattern, {
      problem: internal.prompt,
      context: internal.context,
    });
  } catch (e) {
    return failed(`go-gate: compileScore failed: ${(e as Error).message}`);
  }
  const seeded: InternalState = {
    ...internal,
    score,
    performedBeats: [],
    startedAt: clock(),
  };
  return enterPerformBeat(seeded, 0);
}

// ── Phase 3 transitions ────────────────────────────────────────────

function resolvePerformBeat(
  internal: InternalState,
  res: PerformRes,
  pause: Extract<Pause, { kind: "perform-beat" }>,
  clock: () => string,
): EngineState {
  // Footnote-bug guard: validate voice output shape strictly before recording.
  const shapeError = validateVoiceOutputs(res.voiceOutputs, pause.payload.beat);
  if (shapeError) {
    return failed(`perform-beat[${pause.payload.beatIndex}]: ${shapeError}`);
  }
  const verdictError = validateVerdict(res.verdict);
  if (verdictError) {
    return failed(`perform-beat[${pause.payload.beatIndex}]: ${verdictError}`);
  }
  if (!internal.score) return failed("perform-beat: no compiled score");

  const performed: PerformedBeat = {
    beatIndex: pause.payload.beatIndex,
    voices: res.voiceOutputs.map<PerformedVoice>((v) => ({
      instrument: v.instrument as PerformedVoice["instrument"],
      output: v.output,
      confidence: v.confidence,
    })),
    verdict: res.verdict,
    stateHash: stateHashFor(internal.score.id, pause.payload.beatIndex),
  };
  const beats = [...internal.performedBeats, performed];
  const next: InternalState = { ...internal, performedBeats: beats };

  if (res.verdict.shouldTerminate) {
    return finishRun(next, /*terminatedEarly*/ true, clock);
  }
  const nextIndex = pause.payload.beatIndex + 1;
  if (nextIndex >= internal.score.beats.length) {
    return finishRun(next, /*terminatedEarly*/ false, clock);
  }
  return enterPerformBeat(next, nextIndex);
}

// ── State constructors ────────────────────────────────────────────

function runningPause(internal: InternalState, pause: Pause): EngineState {
  return { kind: "running", pause, internal };
}

function failed(error: string): EngineState {
  return { kind: "failed", error };
}

function enterConfirmFit(
  internal: InternalState,
  summary: PatternSummary,
): EngineState {
  const target = findPattern(internal.patterns, summary.pattern);
  if (!target) return failed(`confirm-fit: pattern '${summary.pattern}' not registered`);
  const next: InternalState = {
    ...internal,
    active: { patternName: target.score.pattern, matchedVerb: summary.matchedVerb },
  };
  return runningPause(next, {
    kind: "confirm-fit",
    payload: { pattern: summary.pattern, matchedVerb: summary.matchedVerb },
    composerPrompt: composerForConfirm(summary),
    instrumentPrompt: instrumentForConfirm(summary),
  });
}

function enterAfterConfirmFit(internal: InternalState): EngineState {
  if (!internal.active) return failed("after-confirm-fit: no active pattern");
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) return failed("after-confirm-fit: active pattern not registered");
  const required = activePattern.requiredContext;
  if (required.length === 0) {
    return enterGoGate(internal);
  }
  const missing = required.filter((k) => !internal.context[k]);
  return runningPause(
    internal,
    makeElicitPause(activePattern, internal.context, missing),
  );
}

function enterDraftPatternRound(
  internal: InternalState,
  round: number,
  priorDraft: Pattern | null,
): EngineState {
  const complexity = pickDebateComplexity(round, internal.debateComplexityHint);
  const next: InternalState = { ...internal, draftRound: round };
  return runningPause(next, {
    kind: "draft-pattern-round",
    payload: {
      round,
      maxRounds: MAESTRO_DRAFT_MAX_ROUNDS,
      debateComplexity: complexity,
      priorDraft,
    },
    composerPrompt: composerForDraft(round, complexity, priorDraft),
    instrumentPrompt: instrumentForDraft(round, complexity, priorDraft),
  });
}

function enterGoGate(internal: InternalState): EngineState {
  if (!internal.active) return failed("go-gate: no active pattern");
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) return failed("go-gate: active pattern not registered");
  return runningPause(
    internal,
    makeGoGatePause(activePattern, internal.context),
  );
}

function enterPerformBeat(internal: InternalState, beatIndex: number): EngineState {
  if (!internal.score) return failed("perform-beat: no compiled score");
  const beat = internal.score.beats[beatIndex];
  if (!beat) return failed(`perform-beat: out-of-range index ${beatIndex}`);
  const previousOutputs = internal.performedBeats.map((b) =>
    b.voices.map((v) => v.output).join("\n"),
  );
  return runningPause(internal, {
    kind: "perform-beat",
    payload: { beatIndex, beat, previousOutputs },
    composerPrompt: composerForPerform(beatIndex, beat),
    instrumentPrompt: instrumentForPerform(beatIndex, beat),
  });
}

function finishRun(
  internal: InternalState,
  terminatedEarly: boolean,
  clock: () => string,
): EngineState {
  if (!internal.score) return failed("finish-run: no compiled score");
  const performance: Performance = {
    scoreId: internal.score.id,
    beats: internal.performedBeats,
    startedAt: internal.startedAt,
    completedAt: clock(),
    outcome: deriveOutcome(internal.performedBeats, terminatedEarly),
  };
  return {
    kind: "done",
    result: { executableScore: internal.score, performance },
  };
}

// ── Pause builders ──────────────────────────────────────────────────

function makeMatchPatternPause(
  prompt: string,
  candidates: readonly PatternSummary[],
): Pause {
  return {
    kind: "match-pattern",
    payload: { prompt, candidates },
    composerPrompt: composerForMatch(prompt, candidates),
    instrumentPrompt: instrumentForMatch(prompt, candidates),
  };
}

function makeElicitPause(
  pattern: Pattern,
  collected: Readonly<Record<string, string>>,
  missingKeys: readonly string[],
): Pause {
  return {
    kind: "elicit-context",
    payload: { pattern: pattern.score.pattern, missingKeys, collected },
    composerPrompt: composerForElicit(pattern, missingKeys, collected),
    instrumentPrompt: instrumentForElicit(pattern, missingKeys, collected),
  };
}

function makeGoGatePause(
  pattern: Pattern,
  context: Readonly<Record<string, string>>,
): Pause {
  return {
    kind: "go-gate",
    payload: {
      pattern: pattern.score.pattern,
      context,
      beats: pattern.score.beats.length,
    },
    composerPrompt: composerForGoGate(pattern, context),
    instrumentPrompt: instrumentForGoGate(pattern, context),
  };
}

// ── Validation ─────────────────────────────────────────────────────

function validateVoiceOutputs(
  outputs: PerformRes["voiceOutputs"],
  beat: Beat,
): string | null {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    return "voiceOutputs must be a non-empty array";
  }
  if (outputs.length !== beat.voices.length) {
    return `voiceOutputs length ${outputs.length} != beat.voices length ${beat.voices.length}`;
  }
  for (let i = 0; i < outputs.length; i++) {
    const v = outputs[i] as Partial<PerformRes["voiceOutputs"][number]>;
    if (typeof v?.instrument !== "string" || v.instrument === "") {
      return `voiceOutputs[${i}].instrument must be a non-empty string`;
    }
    if (typeof v?.output !== "string") {
      return `voiceOutputs[${i}].output must be a string`;
    }
    if (
      typeof v?.confidence !== "number" ||
      Number.isNaN(v.confidence) ||
      v.confidence < 0 ||
      v.confidence > 1
    ) {
      return `voiceOutputs[${i}].confidence must be a number in [0,1]`;
    }
  }
  return null;
}

function validateVerdict(v: MoveVerdict): string | null {
  if (!v) return "verdict required";
  if (!["applied", "failed", "skipped"].includes(v.outcome)) {
    return `verdict.outcome invalid: ${String(v.outcome)}`;
  }
  if (typeof v.confidence !== "number" || v.confidence < 0 || v.confidence > 1) {
    return "verdict.confidence must be a number in [0,1]";
  }
  if (typeof v.reason !== "string") return "verdict.reason must be a string";
  if (typeof v.shouldTerminate !== "boolean") {
    return "verdict.shouldTerminate must be boolean";
  }
  return null;
}

// ── Derivations ────────────────────────────────────────────────────

function findPattern(
  patterns: readonly Pattern[],
  name: string,
): Pattern | undefined {
  return patterns.find((p) => p.score.pattern === name);
}

function bestVerbFor(prompt: string, pattern: Pattern): string | null {
  const lower = prompt.toLowerCase();
  let best: string | null = null;
  for (const verb of pattern.verbTriggers) {
    if (lower.includes(verb.toLowerCase())) {
      if (!best || verb.length > best.length) best = verb;
    }
  }
  return best;
}

function matchVerbs(
  prompt: string,
  patterns: readonly Pattern[],
): readonly PatternSummary[] {
  const hits: PatternSummary[] = [];
  for (const p of patterns) {
    const verb = bestVerbFor(prompt, p);
    if (verb) hits.push({ pattern: p.score.pattern, matchedVerb: verb });
  }
  return hits;
}

function pickDebateComplexity(
  round: number,
  hint: DebateComplexity,
): DebateComplexity {
  // Round 1 honors the caller's classification. Subsequent rounds may
  // escalate one tier per round, capped at 4. This keeps the doc's
  // "classify up-front" intent while allowing escalation on stalls.
  const escalated = Math.min(4, hint + Math.max(0, round - 1)) as DebateComplexity;
  return escalated;
}

function deriveOutcome(
  beats: readonly PerformedBeat[],
  terminatedEarly: boolean,
): Performance["outcome"] {
  if (beats.length === 0) return "in-progress";
  if (beats.some((b) => b.verdict?.outcome === "failed")) return "failed";
  if (terminatedEarly) {
    const last = beats[beats.length - 1].verdict;
    return last?.outcome === "applied" ? "success" : "partial";
  }
  return "success";
}

function defaultClock(): string {
  return new Date().toISOString();
}

function stateHashFor(scoreId: string, beatIndex: number): string {
  return crypto
    .createHash("sha256")
    .update(`engine:${scoreId}:${beatIndex}`)
    .digest("hex");
}

// ── Prompt builders (terse defaults; richer text in prompts.ts) ────

function composerForMatch(prompt: string, candidates: readonly PatternSummary[]): string {
  return [
    "Multiple patterns are available. Pick one or 'no-match'.",
    `prompt: ${prompt}`,
    "candidates:",
    ...candidates.map((c) => `  - ${c.pattern} (matched: '${c.matchedVerb}')`),
  ].join("\n");
}
function instrumentForMatch(_prompt: string, candidates: readonly PatternSummary[]): string {
  return `Pick a pattern from: ${candidates.map((c) => c.pattern).join(", ")} or 'no-match'.`;
}

function composerForConfirm(s: PatternSummary): string {
  return `Confirm pattern fit. Matched verb '${s.matchedVerb}' → '${s.pattern}'. ok?`;
}
function instrumentForConfirm(_s: PatternSummary): string {
  return `Reply ok=true to proceed, ok=false (with optional reroute=<pattern>) to reroute.`;
}

function composerForDraft(
  round: number,
  complexity: DebateComplexity,
  priorDraft: Pattern | null,
): string {
  return [
    `Draft-pattern round ${round}/${MAESTRO_DRAFT_MAX_ROUNDS} (complexity ${complexity}).`,
    "Run the debate sub-agents and synthesize a draft Pattern.",
    priorDraft
      ? `Prior draft existed; iterate.`
      : `No prior draft; propose from scratch.`,
  ].join("\n");
}
function instrumentForDraft(
  round: number,
  complexity: DebateComplexity,
  _priorDraft: Pattern | null,
): string {
  return `Round ${round}; complexity ${complexity}. Spawn proposer${
    complexity >= 2 ? " + skeptic" : ""
  }${complexity >= 3 ? " + pragmatist" : ""}${
    complexity >= 4 ? " + template-critic" : ""
  }.`;
}

function composerForElicit(
  pattern: Pattern,
  missing: readonly string[],
  collected: Readonly<Record<string, string>>,
): string {
  return [
    `Elicit requiredContext for pattern '${pattern.score.pattern}'.`,
    `missing: [${missing.join(", ")}]`,
    `collected: ${JSON.stringify(collected)}`,
  ].join("\n");
}
function instrumentForElicit(
  _pattern: Pattern,
  missing: readonly string[],
  _collected: Readonly<Record<string, string>>,
): string {
  return `Reply with values for: ${missing.join(", ")}. Empty/whitespace will not advance.`;
}

function composerForGoGate(
  pattern: Pattern,
  context: Readonly<Record<string, string>>,
): string {
  return [
    `Ready to compile and execute pattern '${pattern.score.pattern}'.`,
    `beats: ${pattern.score.beats.length}`,
    `context: ${JSON.stringify(context)}`,
    `Reply one of: ${MAESTRO_GO_PHRASES.join(", ")}.`,
  ].join("\n");
}
function instrumentForGoGate(
  _pattern: Pattern,
  _context: Readonly<Record<string, string>>,
): string {
  return `Send a canonical go phrase to advance.`;
}

function composerForPerform(beatIndex: number, beat: Beat): string {
  return [
    `Perform beat ${beatIndex}.`,
    `directive: ${beat.directive}`,
    `voices: ${beat.voices.map((v) => v.instrument).join(", ")}`,
  ].join("\n");
}
function instrumentForPerform(beatIndex: number, beat: Beat): string {
  return `Beat ${beatIndex}: ${beat.directive}`;
}

// ── Optional public helper retained for callers ────────────────────

export function performanceFromScaffold(score: ExecutableScore): Performance {
  return scaffoldPerformance(score);
}
