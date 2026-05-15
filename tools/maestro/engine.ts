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

import type { Pattern } from "../patterns/types";
import type {
  Beat,
  ExecutableScore,
  Performance,
  PerformedBeat,
  PerformedVoice,
} from "../symphony/types";
import { compileScore, algorithmFromPattern } from "../compiler/compile";
import { scaffoldPerformance } from "../symphony/perform";
import {
  VOICE_PRODUCERS as RUNNER_VOICE_PRODUCERS,
  deriveOutcome,
  stateHashFor,
  validateVerdict,
  validateVoiceOutputs,
} from "../symphony/perform-runner";
import type { Pause, PatternSummary } from "./types/pause";
import type { Resolution } from "./types/resolution";
import type { Complexity, VoiceProducer } from "./types/types";
import type { AdvanceResult, EngineConfig, EngineState, InternalState } from "./types/engine";
import type { MaestroEvent } from "./types/event";
import {
  defaultClock,
  defaultPauseIdFactory,
  emitDoneAndExit,
  emitPauseAndExit,
  emitPlannedAndExit,
  readState,
  writeState,
} from "./utils";
import { listPatterns } from "../patterns";
import { appendLog } from "../cli-shared/log";

// ── Public types ────────────────────────────────────────────────────

export const MAESTRO_GO_PHRASES = ["go", "approved", "looks good", "ship it", "proceed"] as const;

export const MAESTRO_DRAFT_MAX_ROUNDS = 6;

/**
 * Re-export of the runner's producer enum.
 *
 * API-stability boundary: when `perform-runner.ts` was split out of
 * the engine, callers that already imported `VOICE_PRODUCERS` from
 * `./engine` kept working without churn. The re-export is intentional
 * — it lets `perform-runner.ts` evolve (move, rename, split further)
 * without touching every callsite.
 *
 * Convention for new code:
 *   - Maestro-internal code → import from `./engine` (this file).
 *   - Symphony-internal code → import from `../symphony/perform-runner`.
 *
 * Either is correct; pick the one that matches the layer you're in.
 */
export const VOICE_PRODUCERS: readonly VoiceProducer[] =
  RUNNER_VOICE_PRODUCERS as readonly VoiceProducer[];

// ── Event helpers ───────────────────────────────────────────────────

function withEvents(state: EngineState, events: readonly MaestroEvent[]): AdvanceResult {
  return Object.assign({}, state, { events }) as AdvanceResult;
}

function appendTerminalEvents(state: EngineState, events: MaestroEvent[]): void {
  switch (state.kind) {
    case "running":
      if (state.pause.kind === "perform-beat") {
        events.push({
          kind: "beat-started",
          beatIndex: state.pause.payload.beatIndex,
          directive: state.pause.payload.beat.directive,
        });
      }
      events.push({
        kind: "pause-emitted",
        pauseKind: state.pause.kind,
        pauseId: state.pause.pauseId,
      });
      break;
    case "done":
      events.push({
        kind: "run-completed",
        outcome: state.result.performance.outcome,
        beatCount: state.result.performance.beats.length,
      });
      break;
    case "failed":
      events.push({ kind: "run-failed", error: state.error });
      break;
    case "planned":
      events.push({ kind: "run-planned", outPath: state.outPath });
      break;
  }
}

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
  if (state.kind === "planned") {
    // createEngine never reaches go-gate, so this branch is unreachable
    // in practice. Guard it anyway to keep the union exhaustive.
    appendLog("maestro", "start", "output", { kind: "planned" });
    emitPlannedAndExit(state, state.outPath ?? "");
    return;
  }
  appendLog("maestro", "start", "output", { kind: "done" });
  emitDoneAndExit(state);
}

/**
 * Same shape as `runStart` but seeds the engine with `planOnly: true`
 * and an `outPath`. The first pause is identical (confirm-fit or
 * classify-complexity); the divergence happens at the go-gate, where
 * the engine emits an `AlgorithmInput` instead of compiling a Score.
 */
export function runPlan(prompt: string, pattern: string, stateFile: string, outPath: string): void {
  appendLog("maestro", "plan", "input", { prompt, pattern, stateFile, outPath });
  const state = createEngine({
    prompt,
    pattern,
    patterns: listPatterns(),
    planOnly: true,
    outPath,
  });
  if (state.kind === "failed") {
    appendLog("maestro", "plan", "output", { kind: "failed", error: state.error });
    process.stderr.write(`ENGINE ERROR: ${state.error}\n`);
    process.exit(1);
  }
  writeState(stateFile, state);
  if (state.kind === "running") {
    appendLog("maestro", "plan", "output", {
      kind: "running",
      pauseKind: state.pause.kind,
      pauseId: state.pause.pauseId,
    });
    emitPauseAndExit(state);
    return;
  }
  if (state.kind === "planned") {
    appendLog("maestro", "plan", "output", { kind: "planned" });
    emitPlannedAndExit(state, state.outPath ?? outPath);
    return;
  }
  // `done` is unreachable from createEngine in plan mode; surface as failure.
  process.stderr.write(`ENGINE ERROR: unexpected terminal state '${state.kind}' from plan start\n`);
  process.exit(1);
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
  if (next.kind === "planned") {
    appendLog("maestro", "resolve", "output", { kind: "planned", outPath: next.outPath });
    if (!next.outPath || next.outPath.length === 0) {
      process.stderr.write(
        `ENGINE ERROR: planned state has no outPath (state file was not seeded by 'maestro plan'?)\n`,
      );
      process.exit(1);
    }
    emitPlannedAndExit(next, next.outPath);
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
export function createEngine(config: EngineConfig): AdvanceResult {
  const clock = config.clock ?? defaultClock;
  const newPauseId = config.pauseIdFactory ?? defaultPauseIdFactory;
  const prompt = config.prompt;
  const pattern = config.pattern;

  const events: MaestroEvent[] = [];
  events.push({ kind: "run-started", prompt, pattern });

  const internal: InternalState = {
    prompt,
    patterns: config.patterns,
    active: undefined,
    context: {},
    draftRound: 0,
    score: undefined,
    performedBeats: [],
    startedAt: clock(),
    planOnly: config.planOnly ?? false,
    ...(config.outPath !== undefined ? { outPath: config.outPath } : {}),
  };

  if (pattern === "new") {
    const state = enterClassifyComplexity(internal, newPauseId);
    appendTerminalEvents(state, events);
    return withEvents(state, events);
  }
  const target = findPattern(internal.patterns, pattern);
  if (!target) {
    const state = failed(`createEngine: pattern '${pattern}' not registered (use "new" to draft)`);
    appendTerminalEvents(state, events);
    return withEvents(state, events);
  }
  const state = enterConfirmFit(internal, summaryOf(target), newPauseId);
  appendTerminalEvents(state, events);
  return withEvents(state, events);
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
): AdvanceResult {
  if (state.kind !== "running") {
    return withEvents(state, []);
  }
  const pause = state.pause;
  const internal = state.internal;
  const clock = opts.clock ?? defaultClock;
  const newPauseId = opts.pauseIdFactory ?? defaultPauseIdFactory;

  const events: MaestroEvent[] = [];

  if (pause.kind !== resolution.kind) {
    const next = failed(
      `resolution kind '${resolution.kind}' does not match pause '${pause.kind}'`,
    );
    appendTerminalEvents(next, events);
    return withEvents(next, events);
  }

  // Idempotency guard: every Resolution must echo the current Pause's
  // pauseId. A resubmission against an already-advanced state file (or
  // a stale resolution from a prior turn) is rejected here, not
  // silently accepted as a fresh transition.
  if (typeof resolution.pauseId !== "string" || resolution.pauseId === "") {
    const next = failed(
      `${pause.kind}: resolution.pauseId is required (expected '${pause.pauseId}')`,
    );
    appendTerminalEvents(next, events);
    return withEvents(next, events);
  }
  if (resolution.pauseId !== pause.pauseId) {
    const next = failed(
      `${pause.kind}: pauseId mismatch (got '${resolution.pauseId}', expected '${pause.pauseId}')`,
    );
    appendTerminalEvents(next, events);
    return withEvents(next, events);
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- exhaustive switch guarantees assignment
  let next!: EngineState;
  switch (pause.kind) {
    case "confirm-fit":
      next = resolveConfirmFit(internal, resolution as ConfirmRes, newPauseId, events);
      break;
    case "classify-complexity":
      next = resolveClassifyComplexity(internal, resolution as ClassifyRes, newPauseId, events);
      break;
    case "draft-pattern-round":
      next = resolveDraftRound(internal, resolution as DraftRes, pause, newPauseId, events);
      break;
    case "elicit-context":
      next = resolveElicitContext(internal, resolution as ElicitRes, newPauseId, events);
      break;
    case "go-gate":
      next = resolveGoGate(internal, resolution as GoRes, clock, newPauseId, events);
      break;
    case "perform-beat":
      next = resolvePerformBeat(
        internal,
        resolution as PerformRes,
        pause,
        clock,
        newPauseId,
        events,
      );
      break;
  }
  appendTerminalEvents(next, events);
  return withEvents(next, events);
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
  events: MaestroEvent[],
): EngineState {
  if (!internal.active) {
    return failed("confirm-fit: no active pattern");
  }
  if (res.ok) {
    events.push({ kind: "pattern-confirmed", pattern: internal.active.patternName });
    return enterAfterConfirmFit(internal, nid);
  }
  // ok=false with reroute → fresh confirm-fit on the new pattern.
  if (res.reroute) {
    events.push({ kind: "pattern-rerouted", from: internal.active.patternName, to: res.reroute });
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
  events: MaestroEvent[],
): EngineState {
  events.push({ kind: "draft-round-completed", round: pause.payload.round, outcome: res.outcome });
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
  events: MaestroEvent[],
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
  const filledKeys = required.filter((k) => !!merged[k]);
  events.push({ kind: "context-collected", keys: filledKeys, missingKeys: missing });
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
  events: MaestroEvent[],
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
  // Plan-only mode: emit AlgorithmInput as the handoff artifact and
  // stop. `symphony parse` + `symphony perform` finish the run.
  if (internal.planOnly) {
    try {
      const algorithm = algorithmFromPattern(activePattern, {
        problem: internal.prompt,
        context: internal.context,
        generatedAt: clock(),
      });
      return {
        kind: "planned",
        algorithm,
        ...(internal.outPath !== undefined ? { outPath: internal.outPath } : {}),
      };
    } catch (e) {
      return failed(`go-gate: algorithmFromPattern failed: ${(e as Error).message}`);
    }
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
  events.push({ kind: "score-compiled", scoreId: score.id, beatCount: score.beats.length });
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
  events: MaestroEvent[],
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
  events.push({
    kind: "beat-completed",
    beatIndex: pause.payload.beatIndex,
    verdictOutcome: res.verdict.outcome,
    confidence: res.verdict.confidence,
  });

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
  events: MaestroEvent[],
): EngineState {
  if (![1, 2, 3, 4].includes(res.complexity)) {
    return failed(
      `classify-complexity: complexity must be 1|2|3|4 (got ${String(res.complexity)})`,
    );
  }
  // classify-complexity is only emitted as a precursor to draft-pattern.
  // Routing happened outside the engine: the caller passed pattern="new"
  // to createEngine because no registered pattern fit the prompt.
  events.push({ kind: "complexity-classified", complexity: res.complexity });
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
  if (!internal.active) {
    return failed("finish-run: no active pattern");
  }
  const activePattern = findPattern(internal.patterns, internal.active.patternName);
  if (!activePattern) {
    return failed("finish-run: active pattern not registered");
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
    result: { executableScore: internal.score, performance, patternScore: activePattern.score },
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
