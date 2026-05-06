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
 *   - agent-driven routing             (pattern picked outside the engine; createEngine begins at confirm-fit or classify-complexity)
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
import { INSTRUMENTS } from "../symphony/types";
import { compileScore } from "../compiler/compile";
import { scaffoldPerformance } from "../symphony/perform";
import type { Pause, PatternSummary } from "./types/pause";
import type { Resolution } from "./types/resolution";
import type { Complexity, VoiceProducer } from "./types/types";
import type { EngineConfig, EngineState, InternalState } from "./types/engine";
import {
  defaultClock,
  defaultPauseIdFactory,
  emitDoneAndExit,
  emitPauseAndExit,
  readState,
  writeState,
} from "./utils";
import { listPatterns } from "../patterns";
import { appendLog } from "../cli-shared/log";

// ── Public types ────────────────────────────────────────────────────

export const MAESTRO_GO_PHRASES = ["go", "approved", "looks good", "ship it", "proceed"] as const;

export const MAESTRO_DRAFT_MAX_ROUNDS = 6;

export const VOICE_PRODUCERS: readonly VoiceProducer[] = [
  "maestro-assessor",
  "maestro-executor",
] as const;

// ── Runs ───────────────

export function runStart(prompt: string, pattern: string, stateFile: string): void {
  appendLog("maestro", "start", "input", { prompt, pattern, stateFile });
  const state = createEngine({ prompt, pattern, patterns: listPatterns() });
  if (state.kind === "failed") {
    appendLog("maestro", "start", "output", { kind: "failed", error: state.error });
    process.stderr.write(`ENGINE ERROR: ${state.error}\n`);
    process.exit(1);
  }
  writeState(stateFile, state);
  if (state.kind === "running") {
    appendLog("maestro", "start", "output", {
      kind: "running",
      pauseKind: state.pause.kind,
      pauseId: state.pause.pauseId,
    });
    emitPauseAndExit(state);
    return;
  }
  appendLog("maestro", "start", "output", { kind: "done" });
  emitDoneAndExit(state);
}

export function runResolve(stateFile: string, resolutionRaw: string): void {
  let resolution: Resolution;
  try {
    resolution = JSON.parse(resolutionRaw) as Resolution;
  } catch (e) {
    appendLog("maestro", "resolve", "input", {
      stateFile,
      parseError: (e as Error).message,
    });
    process.stderr.write(`RESOLUTION PARSE ERROR: ${(e as Error).message}\n`);
    process.exit(1);
  }
  const prior = readState(stateFile);
  appendLog("maestro", "resolve", "input", {
    stateFile,
    priorKind: prior.kind,
    priorPauseKind: prior.kind === "running" ? prior.pause.kind : undefined,
    priorPauseId: prior.kind === "running" ? prior.pause.pauseId : undefined,
    resolutionKind: resolution.kind,
    resolutionPauseId: resolution.pauseId,
  });
  const next = advance(prior, resolution);
  writeState(stateFile, next);
  if (next.kind === "failed") {
    appendLog("maestro", "resolve", "output", { kind: "failed", error: next.error });
    process.stderr.write(`ENGINE ERROR: ${next.error}\n`);
    process.exit(1);
  }
  if (next.kind === "done") {
    appendLog("maestro", "resolve", "output", { kind: "done" });
    emitDoneAndExit(next);
    return;
  }
  appendLog("maestro", "resolve", "output", {
    kind: "running",
    pauseKind: next.pause.kind,
    pauseId: next.pause.pauseId,
  });
  emitPauseAndExit(next);
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * `pattern` is required:
 *   - a registered pattern name → first pause is `confirm-fit`
 *   - the literal string "new"  → first pause is `classify-complexity`
 *     (precursor to draft-pattern; for prompts where no registered pattern fits)
 *
 * Pattern selection happens *outside* the engine: the agent reads
 * `symphony list-patterns --json`, picks one (or "new"), and passes it
 * to `createEngine`. There is no routing pause; the engine begins with
 * an active pattern (or with the explicit intent to draft one).
 */
export function createEngine(config: EngineConfig): EngineState {
  const clock = config.clock ?? defaultClock;
  const newPauseId = config.pauseIdFactory ?? defaultPauseIdFactory;
  const prompt = config.prompt;
  const pattern = config.pattern;

  const internal: InternalState = {
    prompt,
    patterns: config.patterns,
    active: undefined,
    context: {},
    draftRound: 0,
    score: undefined,
    performedBeats: [],
    startedAt: clock(),
  };

  if (pattern === "new") {
    return enterClassifyComplexity(internal, newPauseId);
  }
  const target = findPattern(internal.patterns, pattern);
  if (!target) {
    return failed(`createEngine: pattern '${pattern}' not registered (use "new" to draft)`);
  }
  return enterConfirmFit(internal, summaryOf(target), newPauseId);
}

// ── Reducer ────────────────────────────────────────────────────────

export interface AdvanceOptions {
  readonly clock?: () => string;
  /** Override the pauseId factory. Tests inject deterministic ids. */
  readonly pauseIdFactory?: () => string;
}

export function advance(
  state: EngineState,
  resolution: Resolution,
  opts: AdvanceOptions = {},
): EngineState {
  if (state.kind !== "running") {
    return state;
  }
  const pause = state.pause;
  const internal = state.internal;
  const clock = opts.clock ?? defaultClock;
  const newPauseId = opts.pauseIdFactory ?? defaultPauseIdFactory;

  if (pause.kind !== resolution.kind) {
    return failed(`resolution kind '${resolution.kind}' does not match pause '${pause.kind}'`);
  }

  // Idempotency guard: every Resolution must echo the current Pause's
  // pauseId. A resubmission against an already-advanced state file (or
  // a stale resolution from a prior turn) is rejected here, not
  // silently accepted as a fresh transition.
  if (typeof resolution.pauseId !== "string" || resolution.pauseId === "") {
    return failed(`${pause.kind}: resolution.pauseId is required (expected '${pause.pauseId}')`);
  }
  if (resolution.pauseId !== pause.pauseId) {
    return failed(
      `${pause.kind}: pauseId mismatch (got '${resolution.pauseId}', expected '${pause.pauseId}')`,
    );
  }

  switch (pause.kind) {
    case "confirm-fit":
      return resolveConfirmFit(internal, resolution as ConfirmRes, newPauseId);
    case "classify-complexity":
      return resolveClassifyComplexity(internal, resolution as ClassifyRes, newPauseId);
    case "draft-pattern-round":
      return resolveDraftRound(internal, resolution as DraftRes, pause, newPauseId);
    case "elicit-context":
      return resolveElicitContext(internal, resolution as ElicitRes, newPauseId);
    case "go-gate":
      return resolveGoGate(internal, resolution as GoRes, clock, newPauseId);
    case "perform-beat":
      return resolvePerformBeat(internal, resolution as PerformRes, pause, clock, newPauseId);
  }
}

// ── Phase 1 transitions ────────────────────────────────────────────

type ConfirmRes = Extract<Resolution, { kind: "confirm-fit" }>;
type ClassifyRes = Extract<Resolution, { kind: "classify-complexity" }>;
type DraftRes = Extract<Resolution, { kind: "draft-pattern-round" }>;
type ElicitRes = Extract<Resolution, { kind: "elicit-context" }>;
type GoRes = Extract<Resolution, { kind: "go-gate" }>;
type PerformRes = Extract<Resolution, { kind: "perform-beat" }>;

function resolveConfirmFit(
  internal: InternalState,
  res: ConfirmRes,
  nid: () => string,
): EngineState {
  if (res.ok) {
    return enterAfterConfirmFit(internal, nid);
  }
  // ok=false with reroute → fresh confirm-fit on the new pattern.
  if (res.reroute) {
    const target = findPattern(internal.patterns, res.reroute);
    if (!target) {
      return failed(`confirm-fit: reroute target '${res.reroute}' not registered`);
    }
    const cleared: InternalState = { ...internal, active: undefined, context: {} };
    return enterConfirmFit(cleared, summaryOf(target), nid);
  }
  // ok=false without reroute → routing happens outside the engine, so the
  // only honest response is to fail the run. The agent restarts with a
  // new `maestro start --pattern <name|new>`.
  return failed(
    "confirm-fit: rejected without reroute target; restart `maestro start` with a new --pattern",
  );
}

function resolveDraftRound(
  internal: InternalState,
  res: DraftRes,
  pause: Extract<Pause, { kind: "draft-pattern-round" }>,
  nid: () => string,
): EngineState {
  if (res.outcome === "approve") {
    if (!res.nextDraft) {
      return failed("draft-pattern-round: approve requires nextDraft");
    }
    const draft = res.nextDraft;
    // Add the approved draft to the registry and treat it as active.
    // Skip confirm-fit because the user just designed it.
    const augmentedPatterns = [...internal.patterns, draft];
    return enterAfterConfirmFit(
      {
        ...internal,
        patterns: augmentedPatterns,
        active: { patternName: draft.score.pattern },
        context: {},
      },
      nid,
    );
  }
  // edit / ambiguous → next round (cap enforced in code).
  const next = pause.payload.round + 1;
  if (next > MAESTRO_DRAFT_MAX_ROUNDS) {
    return failed(`draft-pattern: MAX_ROUNDS=${MAESTRO_DRAFT_MAX_ROUNDS} exceeded`);
  }
  return enterDraftPatternRound(
    internal,
    next,
    pause.payload.baseHint,
    res.nextDraft ?? pause.payload.priorDraft,
    nid,
  );
}

// ── Phase 2 transitions ────────────────────────────────────────────

function resolveElicitContext(
  internal: InternalState,
  res: ElicitRes,
  nid: () => string,
): EngineState {
  if (!internal.active) {
    return failed("elicit-context: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("elicit-context: active pattern not registered");
  }
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
    return runningPause(next, makeElicitPause(activePattern, merged, missing, nid));
  }
  return enterGoGate(next, nid);
}

function resolveGoGate(
  internal: InternalState,
  res: GoRes,
  clock: () => string,
  nid: () => string,
): EngineState {
  if (!internal.active) {
    return failed("go-gate: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("go-gate: active pattern not registered");
  }
  const phrase = res.phrase.trim().toLowerCase();
  if (!(MAESTRO_GO_PHRASES as readonly string[]).includes(phrase)) {
    return runningPause(internal, makeGoGatePause(activePattern, internal.context, nid));
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
  return enterPerformBeat(seeded, 0, nid);
}

// ── Phase 3 transitions ────────────────────────────────────────────

function resolvePerformBeat(
  internal: InternalState,
  res: PerformRes,
  pause: Extract<Pause, { kind: "perform-beat" }>,
  clock: () => string,
  nid: () => string,
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
  if (!internal.score) {
    return failed("perform-beat: no compiled score");
  }

  const performed: PerformedBeat = {
    beatIndex: pause.payload.beatIndex,
    voices: res.voiceOutputs.map<PerformedVoice>((v) => ({
      instrument: v.instrument as PerformedVoice["instrument"],
      output: v.output,
      confidence: v.confidence,
      producedBy: v.producedBy,
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
  return enterPerformBeat(next, nextIndex, nid);
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
  nid: () => string,
): EngineState {
  const target = findPattern(internal.patterns, summary.pattern);
  if (!target) {
    return failed(`confirm-fit: pattern '${summary.pattern}' not registered`);
  }
  const next: InternalState = {
    ...internal,
    active: { patternName: target.score.pattern },
  };
  return runningPause(next, {
    kind: "confirm-fit",
    pauseId: nid(),
    payload: { pattern: summary.pattern, description: summary.description },
    composerPrompt: composerForConfirm(summary),
    instrumentPrompt: instrumentForConfirm(summary),
  });
}

function enterAfterConfirmFit(internal: InternalState, nid: () => string): EngineState {
  if (!internal.active) {
    return failed("after-confirm-fit: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("after-confirm-fit: active pattern not registered");
  }
  const required = activePattern.requiredContext;
  if (required.length === 0) {
    return enterGoGate(internal, nid);
  }
  const missing = required.filter((k) => !internal.context[k]);
  return runningPause(internal, makeElicitPause(activePattern, internal.context, missing, nid));
}

function enterDraftPatternRound(
  internal: InternalState,
  round: number,
  baseHint: Complexity,
  priorDraft: Pattern | undefined,
  nid: () => string,
): EngineState {
  const complexity = pickDebateComplexity(round, baseHint);
  const next: InternalState = { ...internal, draftRound: round };
  return runningPause(next, {
    kind: "draft-pattern-round",
    pauseId: nid(),
    payload: {
      round,
      maxRounds: MAESTRO_DRAFT_MAX_ROUNDS,
      complexity,
      baseHint,
      priorDraft,
    },
    composerPrompt: composerForDraft(round, complexity, priorDraft),
    instrumentPrompt: instrumentForDraft(round, complexity, priorDraft),
  });
}

function enterClassifyComplexity(internal: InternalState, nid: () => string): EngineState {
  return runningPause(internal, {
    kind: "classify-complexity",
    pauseId: nid(),
    payload: { prompt: internal.prompt },
    composerPrompt: composerForClassify(internal.prompt),
    instrumentPrompt: instrumentForClassify(),
  });
}

function resolveClassifyComplexity(
  internal: InternalState,
  res: ClassifyRes,
  nid: () => string,
): EngineState {
  if (![1, 2, 3, 4].includes(res.complexity)) {
    return failed(
      `classify-complexity: complexity must be 1|2|3|4 (got ${String(res.complexity)})`,
    );
  }
  // classify-complexity is only emitted as a precursor to draft-pattern.
  // Routing happened outside the engine: the caller passed pattern="new"
  // to createEngine because no registered pattern fit the prompt.
  return enterDraftPatternRound(internal, 1, res.complexity, undefined, nid);
}

function enterGoGate(internal: InternalState, nid: () => string): EngineState {
  if (!internal.active) {
    return failed("go-gate: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("go-gate: active pattern not registered");
  }
  return runningPause(internal, makeGoGatePause(activePattern, internal.context, nid));
}

function enterPerformBeat(
  internal: InternalState,
  beatIndex: number,
  nid: () => string,
): EngineState {
  if (!internal.score) {
    return failed("perform-beat: no compiled score");
  }
  const beat = internal.score.beats[beatIndex];
  if (!beat) {
    return failed(`perform-beat: out-of-range index ${beatIndex}`);
  }
  const previousOutputs = internal.performedBeats.map((b) => {
    const priorBeat = internal.score?.beats[b.beatIndex];
    return {
      beatIndex: b.beatIndex,
      directive: priorBeat?.directive ?? "",
      voices: b.voices.map((v) => ({ instrument: v.instrument, output: v.output })),
      verdictOutcome: b.verdict?.outcome ?? "skipped",
    };
  });
  return runningPause(internal, {
    kind: "perform-beat",
    pauseId: nid(),
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
  if (!internal.score) {
    return failed("finish-run: no compiled score");
  }
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

function makeElicitPause(
  pattern: Pattern,
  collected: Readonly<Record<string, string>>,
  missingKeys: readonly string[],
  nid: () => string,
): Pause {
  return {
    kind: "elicit-context",
    pauseId: nid(),
    payload: { pattern: pattern.score.pattern, missingKeys, collected },
    composerPrompt: composerForElicit(pattern, missingKeys, collected),
    instrumentPrompt: instrumentForElicit(pattern, missingKeys, collected),
  };
}

function makeGoGatePause(
  pattern: Pattern,
  context: Readonly<Record<string, string>>,
  nid: () => string,
): Pause {
  return {
    kind: "go-gate",
    pauseId: nid(),
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

function validateVoiceOutputs(outputs: PerformRes["voiceOutputs"], beat: Beat): string | undefined {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    return "voiceOutputs must be a non-empty array";
  }
  if (outputs.length !== beat.voices.length) {
    return `voiceOutputs length ${outputs.length} != beat.voices length ${beat.voices.length}`;
  }
  for (let i = 0; i < outputs.length; i += 1) {
    const v = outputs[i] as Partial<PerformRes["voiceOutputs"][number]>;
    if (typeof v?.instrument !== "string" || v.instrument === "") {
      return `voiceOutputs[${i}].instrument must be a non-empty string`;
    }
    if (!(INSTRUMENTS as readonly string[]).includes(v.instrument)) {
      return `voiceOutputs[${i}].instrument '${v.instrument}' is not one of: ${INSTRUMENTS.join(", ")}`;
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
    if (
      typeof v?.producedBy !== "string" ||
      !(VOICE_PRODUCERS as readonly string[]).includes(v.producedBy)
    ) {
      return `voiceOutputs[${i}].producedBy must be one of: ${VOICE_PRODUCERS.join(", ")}`;
    }
  }
  return undefined;
}

function validateVerdict(v: MoveVerdict): string | undefined {
  if (!v) {
    return "verdict required";
  }
  if (!["applied", "failed", "skipped"].includes(v.outcome)) {
    return `verdict.outcome invalid: ${String(v.outcome)}`;
  }
  if (typeof v.confidence !== "number" || v.confidence < 0 || v.confidence > 1) {
    return "verdict.confidence must be a number in [0,1]";
  }
  if (typeof v.reason !== "string") {
    return "verdict.reason must be a string";
  }
  if (typeof v.shouldTerminate !== "boolean") {
    return "verdict.shouldTerminate must be boolean";
  }
  return undefined;
}

// ── Derivations ────────────────────────────────────────────────────

function findPattern(patterns: readonly Pattern[], name: string): Pattern | undefined {
  return patterns.find((p) => p.score.pattern === name);
}

function summaryOf(pattern: Pattern): PatternSummary {
  return { pattern: pattern.score.pattern, description: pattern.description };
}

function pickDebateComplexity(round: number, hint: Complexity): Complexity {
  // Round 1 honors the caller's classification. Subsequent rounds may
  // escalate one tier per round, capped at 4. This keeps the doc's
  // "classify up-front" intent while allowing escalation on stalls.
  const escalated = Math.min(4, hint + Math.max(0, round - 1)) as Complexity;
  return escalated;
}

function deriveOutcome(
  beats: readonly PerformedBeat[],
  terminatedEarly: boolean,
): Performance["outcome"] {
  if (beats.length === 0) {
    return "in-progress";
  }
  if (beats.some((b) => b.verdict?.outcome === "failed")) {
    return "failed";
  }
  if (terminatedEarly) {
    const last = beats[beats.length - 1].verdict;
    return last?.outcome === "applied" ? "success" : "partial";
  }
  // No beat was actually applied (all skipped) — the run completed its
  // shape but produced no work. Refuse to call that "success".
  if (!beats.some((b) => b.verdict?.outcome === "applied")) {
    return "partial";
  }
  return "success";
}

function stateHashFor(scoreId: string, beatIndex: number): string {
  return crypto.createHash("sha256").update(`engine:${scoreId}:${beatIndex}`).digest("hex");
}

// ── Prompt builders (terse defaults; richer text in prompts.ts) ────

function composerForConfirm(s: PatternSummary): string {
  return `Confirm pattern fit. '${s.pattern}': ${s.description}. ok?`;
}
function instrumentForConfirm(_s: PatternSummary): string {
  return `Reply ok=true to proceed, ok=false (with optional reroute=<pattern>) to reroute.`;
}

function composerForDraft(
  round: number,
  complexity: Complexity,
  priorDraft: Pattern | undefined,
): string {
  return [
    `Draft-pattern round ${round}/${MAESTRO_DRAFT_MAX_ROUNDS} (complexity ${complexity}).`,
    "Run the debate sub-agents and synthesize a draft Pattern.",
    priorDraft ? `Prior draft existed; iterate.` : `No prior draft; propose from scratch.`,
  ].join("\n");
}
function instrumentForDraft(
  round: number,
  complexity: Complexity,
  _priorDraft: Pattern | undefined,
): string {
  return `Round ${round}; complexity ${complexity}. Spawn proposer${
    complexity >= 2 ? " + skeptic" : ""
  }${complexity >= 3 ? " + pragmatist" : ""}${complexity >= 4 ? " + template-critic" : ""}.`;
}

function composerForClassify(prompt: string): string {
  return [
    `Classify the user's prompt by complexity (1|2|3|4) for the draft-pattern debate.`,
    `  1 = trivial (proposer only)`,
    `  2 = standard (proposer + skeptic)`,
    `  3 = high (proposer + skeptic + pragmatist)`,
    `  4 = novel (proposer + skeptic + pragmatist + template-critic)`,
    ``,
    `Prompt: ${prompt}`,
    ``,
    `Reply with: { kind: 'classify-complexity', complexity: 1|2|3|4 }`,
  ].join("\n");
}
function instrumentForClassify(): string {
  return `Reply with complexity 1, 2, 3, or 4 based on the prompt's novelty and risk.`;
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

function composerForGoGate(pattern: Pattern, context: Readonly<Record<string, string>>): string {
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
