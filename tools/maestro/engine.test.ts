/**
 * engine.test.ts — Maestro engine state-machine tests.
 *
 * The engine is a pure reducer: createEngine + advance. These tests
 * pin every gate that, in the previous markdown-only maestro, an LLM
 * could (and did) skip:
 *
 *   - createEngine requires explicit pattern pick      → routing is external
 *   - confirm-fit reroute / fail-without-reroute        → re-enters phase 1 cleanly
 *   - elicit-context refuses empty values              → footnote-class control-flow gate
 *   - go-gate refuses vague positive language          → only canonical phrases advance
 *   - classify-complexity → draft-pattern-round 1       → pattern="new" entry path
 *   - draft-pattern hard MAX_ROUNDS=6                   → terminal failure, no backdoor
 *   - perform-beat shape validation                     → THE footnote bug
 *   - completed Performance has correct shape           → integration with scaffoldPerformance
 */

import { createEngine, advance, MAESTRO_GO_PHRASES } from "./engine";
import type { Pause } from "./types/pause";
import type { Resolution } from "./types/resolution";
import { listPatterns, getPattern } from "../patterns";
import type { Pattern } from "../patterns/types";

const allPatterns = listPatterns();

function expectPause<K extends Pause["kind"]>(
  state: ReturnType<typeof createEngine>,
  kind: K,
): Extract<Pause, { kind: K }> {
  if (state.kind !== "running") {
    throw new Error(
      `expected running state with pause '${kind}', got ${state.kind}: ${
        state.kind === "failed" ? state.error : state.kind
      }`,
    );
  }
  if (state.pause.kind !== kind) {
    throw new Error(`expected pause '${kind}', got '${state.pause.kind}'`);
  }
  return state.pause as Extract<Pause, { kind: K }>;
}

function pid(state: ReturnType<typeof createEngine>): string {
  if (state.kind !== "running") {
    throw new Error(`pid: state is ${state.kind}, expected running`);
  }
  return state.pause.pauseId;
}

// ── createEngine routing entry-points ──────────────────────────────

describe("createEngine entry-points", () => {
  test("registered pattern name → first pause is confirm-fit", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const pause = expectPause(s0, "confirm-fit");
    expect(pause.payload.pattern).toBe("refactor");
  });

  test("pattern='new' → first pause is classify-complexity", () => {
    const s0 = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
      pattern: "new",
    });
    expectPause(s0, "classify-complexity");
  });

  test("unknown pattern name → engine fails", () => {
    const s0 = createEngine({
      prompt: "anything",
      patterns: allPatterns,
      pattern: "nonexistent-pattern",
    });
    expect(s0.kind).toBe("failed");
    if (s0.kind === "failed") {
      expect(s0.error).toMatch(/not registered/);
    }
  });
});

// ── Phase 1: confirm-fit ───────────────────────────────────────────

describe("confirm-fit", () => {
  test("ok=true advances to elicit-context", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const s1 = advance(s0, { kind: "confirm-fit", pauseId: pid(s0), ok: true });
    const pause = expectPause(s1, "elicit-context");
    expect(pause.payload.pattern).toBe("refactor");
    expect(pause.payload.missingKeys).toEqual(["target", "invariant"]);
  });

  test("ok=false with reroute name emits a fresh confirm-fit on the new pattern", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const s1 = advance(s0, {
      kind: "confirm-fit",
      pauseId: pid(s0),
      ok: false,
      reroute: "investigate",
    });
    // Reroute does NOT skip confirm-fit — a typo'd reroute name would crash
    // silently otherwise. User must explicitly accept the new fit.
    const pause = expectPause(s1, "confirm-fit");
    expect(pause.payload.pattern).toBe("investigate");
  });

  test("ok=false without reroute fails the engine (routing is external)", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const s1 = advance(s0, { kind: "confirm-fit", pauseId: pid(s0), ok: false });
    // Routing happens outside the engine; the only honest response is to fail
    // so the agent restarts with a new --pattern.
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") {
      expect(s1.error).toMatch(/reroute|restart/);
    }
  });

  test("reroute to unknown pattern fails the engine", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const s1 = advance(s0, {
      kind: "confirm-fit",
      pauseId: pid(s0),
      ok: false,
      reroute: "nonexistent-pattern",
    });
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") {
      expect(s1.error).toMatch(/reroute target/);
    }
  });
});

// ── Phase 2: elicit-context ────────────────────────────────────────

describe("elicit-context", () => {
  function reachElicit(): ReturnType<typeof createEngine> {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    return advance(s0, { kind: "confirm-fit", pauseId: pid(s0), ok: true });
  }

  test("empty value re-emits elicit-context with key still missing", () => {
    const s0 = reachElicit();
    const s1 = advance(s0, {
      kind: "elicit-context",
      pauseId: pid(s0),
      values: { target: "", invariant: "imports type-check" },
    });
    const pause = expectPause(s1, "elicit-context");
    expect(pause.payload.missingKeys).toEqual(["target"]);
  });

  test("whitespace-only value treated as empty", () => {
    const s0 = reachElicit();
    const s1 = advance(s0, {
      kind: "elicit-context",
      pauseId: pid(s0),
      values: { target: "   ", invariant: "imports type-check" },
    });
    const pause = expectPause(s1, "elicit-context");
    expect(pause.payload.missingKeys).toContain("target");
  });

  test("all keys filled advances to go-gate", () => {
    const s0 = reachElicit();
    const s1 = advance(s0, {
      kind: "elicit-context",
      pauseId: pid(s0),
      values: { target: "rename loadScore", invariant: "imports type-check" },
    });
    expectPause(s1, "go-gate");
  });

  test("extra unknown keys are dropped silently (forward-compat)", () => {
    const s0 = reachElicit();
    const s1 = advance(s0, {
      kind: "elicit-context",
      pauseId: pid(s0),
      values: {
        target: "rename loadScore",
        invariant: "imports type-check",
        bonusKey: "ignored",
      },
    });
    expectPause(s1, "go-gate");
  });
});

// ── Phase 2: go-gate ───────────────────────────────────────────────

describe("go-gate", () => {
  function reachGate(): ReturnType<typeof createEngine> {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const s1 = advance(s0, { kind: "confirm-fit", pauseId: pid(s0), ok: true });
    return advance(s1, {
      kind: "elicit-context",
      pauseId: pid(s1),
      values: { target: "rename loadScore", invariant: "imports type-check" },
    });
  }

  test.each(MAESTRO_GO_PHRASES)("'%s' advances to perform-beat 0", (phrase) => {
    const s0 = reachGate();
    const s1 = advance(s0, { kind: "go-gate", pauseId: pid(s0), phrase });
    const pause = expectPause(s1, "perform-beat");
    expect(pause.payload.beatIndex).toBe(0);
  });

  test.each(["sounds fine-ish", "yeah maybe", "ok i guess", "fine", "yes please", "", "  "])(
    "vague phrase '%s' re-emits go-gate",
    (phrase) => {
      const s0 = reachGate();
      const s1 = advance(s0, { kind: "go-gate", pauseId: pid(s0), phrase });
      expectPause(s1, "go-gate");
    },
  );

  test("phrase match is case-insensitive and trims whitespace", () => {
    const s0 = reachGate();
    const s1 = advance(s0, { kind: "go-gate", pauseId: pid(s0), phrase: "  GO  " });
    expectPause(s1, "perform-beat");
  });
});

// ── Phase 1.3: classify-complexity → draft-pattern hard cap ────────

describe("draft-pattern flow", () => {
  function makeStubPattern(name: string): Pattern {
    return {
      score: {
        pattern: name,
        domain: "feature",
        beats: [
          {
            step: "stub",
            level: 3,
            instrument: "integrate",
            directive: "stub directive",
          },
        ],
      },
      description: "stub pattern for tests",
      requiredContext: [],
    };
  }

  test("classify-complexity → draft-pattern-round 1 with chosen complexity", () => {
    const s0 = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
      pattern: "new",
    });
    expectPause(s0, "classify-complexity");
    const s1 = advance(s0, {
      kind: "classify-complexity",
      pauseId: pid(s0),
      complexity: 2,
    });
    const pause = expectPause(s1, "draft-pattern-round");
    expect(pause.payload.round).toBe(1);
    expect(pause.payload.baseHint).toBe(2);
    expect(pause.payload.priorDraft).toBeUndefined();
  });

  test("classify-complexity rejects out-of-range value", () => {
    const s0 = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
      pattern: "new",
    });
    const s1 = advance(s0, {
      kind: "classify-complexity",
      pauseId: pid(s0),
      complexity: 5 as unknown as 1 | 2 | 3 | 4,
    });
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") {
      expect(s1.error).toMatch(/complexity/);
    }
  });

  test("draft-pattern terminates at round 6 with failed engine state", () => {
    let state = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
      pattern: "new",
    });
    state = advance(state, { kind: "classify-complexity", pauseId: pid(state), complexity: 2 });
    for (let i = 0; i < 6; i += 1) {
      const pause = expectPause(state, "draft-pattern-round");
      expect(pause.payload.round).toBe(i + 1);
      state = advance(state, { kind: "draft-pattern-round", pauseId: pid(state), outcome: "edit" });
    }
    // 7th iteration should be terminal failure.
    expect(state.kind).toBe("failed");
    if (state.kind === "failed") {
      expect(state.error).toMatch(/MAX_ROUNDS/);
    }
  });

  test("approve at round 1 transitions out of debate", () => {
    let state = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
      pattern: "new",
    });
    state = advance(state, { kind: "classify-complexity", pauseId: pid(state), complexity: 2 });
    expectPause(state, "draft-pattern-round");
    const s1 = advance(state, {
      kind: "draft-pattern-round",
      pauseId: pid(state),
      outcome: "approve",
      nextDraft: makeStubPattern("frobnicate"),
    });
    // After approval, engine treats the new pattern as the active one
    // and skips confirm-fit (the user just designed it). With no
    // requiredContext, it goes straight to go-gate.
    expectPause(s1, "go-gate");
  });
});

// ── Phase 3: perform-beat shape validation (the footnote bug) ──────

describe("perform-beat shape validation", () => {
  function reachPerform(): ReturnType<typeof createEngine> {
    const s0 = createEngine({
      prompt: "understand the architecture",
      patterns: allPatterns,
      pattern: "investigate",
    });
    // investigate has no requiredContext → confirm-fit → go-gate.
    const s1 = advance(s0, { kind: "confirm-fit", pauseId: pid(s0), ok: true });
    return advance(s1, { kind: "go-gate", pauseId: pid(s1), phrase: "go" });
  }

  test("valid voice output advances to next beat", () => {
    const s0 = reachPerform();
    const pause0 = expectPause(s0, "perform-beat");
    expect(pause0.payload.beatIndex).toBe(0);
    const s1 = advance(s0, {
      kind: "perform-beat",
      pauseId: pid(s0),
      voiceOutputs: [
        {
          instrument: "order",
          output: "restated",
          confidence: 0.9,
          producedBy: "maestro-assessor",
        },
      ],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    });
    const pause1 = expectPause(s1, "perform-beat");
    expect(pause1.payload.beatIndex).toBe(1);
  });

  test("missing instrument field → engine fails (footnote-bug guard)", () => {
    const s0 = reachPerform();
    const bad = {
      kind: "perform-beat",
      pauseId: pid(s0),
      voiceOutputs: [{ output: "x", confidence: 0.9 }],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    } as unknown as Resolution;
    const s1 = advance(s0, bad);
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") {
      expect(s1.error).toMatch(/voice/i);
    }
  });

  test("non-string output → engine fails", () => {
    const s0 = reachPerform();
    const bad = {
      kind: "perform-beat",
      pauseId: pid(s0),
      voiceOutputs: [
        { instrument: "order", output: 42, confidence: 0.9, producedBy: "maestro-assessor" },
      ],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    } as unknown as Resolution;
    const s1 = advance(s0, bad);
    expect(s1.kind).toBe("failed");
  });

  test("confidence out of [0,1] → engine fails", () => {
    const s0 = reachPerform();
    const s1 = advance(s0, {
      kind: "perform-beat",
      pauseId: pid(s0),
      voiceOutputs: [
        { instrument: "order", output: "x", confidence: 1.5, producedBy: "maestro-assessor" },
      ],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    });
    expect(s1.kind).toBe("failed");
  });

  test("shouldTerminate=true on failed verdict completes Performance with outcome=failed", () => {
    const s0 = reachPerform();
    const s1 = advance(s0, {
      kind: "perform-beat",
      pauseId: pid(s0),
      voiceOutputs: [
        {
          instrument: "order",
          output: "couldnt",
          confidence: 0.2,
          producedBy: "maestro-assessor",
        },
      ],
      verdict: {
        outcome: "failed",
        confidence: 0.2,
        reason: "blocked",
        shouldTerminate: true,
      },
    });
    expect(s1.kind).toBe("done");
    if (s1.kind === "done") {
      expect(s1.result.performance.outcome).toBe("failed");
    }
  });
});

// ── EngineState JSON round-trip (CLI persists across turns) ───────

describe("EngineState JSON round-trip", () => {
  test("running state survives JSON.stringify/parse and advances correctly", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const roundTripped = JSON.parse(JSON.stringify(s0)) as typeof s0;
    expect(roundTripped.kind).toBe("running");
    // Advance the round-tripped state.
    const s1 = advance(roundTripped, { kind: "confirm-fit", pauseId: pid(roundTripped), ok: true });
    expectPause(s1, "elicit-context");
  });

  test("perform-beat state survives JSON round-trip mid-execution", () => {
    let state = createEngine({
      prompt: "understand the codebase",
      patterns: allPatterns,
      pattern: "investigate",
    });
    state = advance(state, { kind: "confirm-fit", pauseId: pid(state), ok: true });
    state = advance(state, { kind: "go-gate", pauseId: pid(state), phrase: "go" });
    // mid-run round-trip
    state = JSON.parse(JSON.stringify(state)) as typeof state;
    expectPause(state, "perform-beat");
    state = advance(state, {
      kind: "perform-beat",
      pauseId: pid(state),
      voiceOutputs: [
        { instrument: "order", output: "ok", confidence: 0.9, producedBy: "maestro-assessor" },
      ],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    });
    expectPause(state, "perform-beat");
  });
});

// ── pauseId idempotency guard ──────────────────────────────────────

describe("pauseId idempotency", () => {
  test("missing pauseId on resolution fails the engine", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    // Cast around the type system to simulate a hand-rolled JSON resolution
    // that forgot to echo pauseId.
    const s1 = advance(s0, { kind: "confirm-fit", ok: true } as unknown as Resolution);
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") {
      expect(s1.error).toMatch(/pauseId is required/);
    }
  });

  test("stale pauseId (already-advanced state) fails the engine", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const stalePauseId = pid(s0);
    // First advance consumes the pauseId.
    const s1 = advance(s0, {
      kind: "confirm-fit",
      pauseId: stalePauseId,
      ok: true,
    });
    expectPause(s1, "elicit-context");
    // Re-submitting the same s0+resolution against s1 (different pauseId) must fail.
    const s2 = advance(s1, {
      kind: "elicit-context",
      pauseId: stalePauseId, // wrong; should be pid(s1)
      values: { target: "x", invariant: "y" },
    });
    expect(s2.kind).toBe("failed");
    if (s2.kind === "failed") {
      expect(s2.error).toMatch(/pauseId mismatch/);
    }
  });

  test("each pause has a fresh pauseId", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const id0 = pid(s0);
    const s1 = advance(s0, { kind: "confirm-fit", pauseId: id0, ok: true });
    const id1 = pid(s1);
    expect(id0).not.toBe(id1);
    expect(typeof id1).toBe("string");
    expect(id1.length).toBeGreaterThan(0);
  });

  test("re-emitted pause (rejected go phrase) gets a new pauseId", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    const s1 = advance(s0, { kind: "confirm-fit", pauseId: pid(s0), ok: true });
    const s2 = advance(s1, {
      kind: "elicit-context",
      pauseId: pid(s1),
      values: { target: "x", invariant: "y" },
    });
    expectPause(s2, "go-gate");
    const goId = pid(s2);
    // Vague phrase re-emits go-gate with a fresh pauseId.
    const s3 = advance(s2, { kind: "go-gate", pauseId: goId, phrase: "fine" });
    expectPause(s3, "go-gate");
    expect(pid(s3)).not.toBe(goId);
  });

  test("pauseIdFactory injection produces deterministic ids", () => {
    let counter = 0;
    const factory = () => {
      counter += 1;
      return `pid-${counter}`;
    };
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
      pauseIdFactory: factory,
    });
    expect(pid(s0)).toBe("pid-1");
    const s1 = advance(
      s0,
      { kind: "confirm-fit", pauseId: "pid-1", ok: true },
      { pauseIdFactory: factory },
    );
    expect(pid(s1)).toBe("pid-2");
  });
});

// ── producedBy required on voice outputs ───────────────────────────

describe("voiceOutputs.producedBy validation", () => {
  function reachPerform(): ReturnType<typeof createEngine> {
    const s0 = createEngine({
      prompt: "understand the architecture",
      patterns: allPatterns,
      pattern: "investigate",
    });
    const s1 = advance(s0, { kind: "confirm-fit", pauseId: pid(s0), ok: true });
    return advance(s1, { kind: "go-gate", pauseId: pid(s1), phrase: "go" });
  }

  test("missing producedBy fails the engine", () => {
    const s0 = reachPerform();
    const bad = {
      kind: "perform-beat",
      pauseId: pid(s0),
      voiceOutputs: [{ instrument: "order", output: "x", confidence: 0.9 }],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    } as unknown as Resolution;
    const s1 = advance(s0, bad);
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") {
      expect(s1.error).toMatch(/producedBy/);
    }
  });

  test("invalid producedBy value fails the engine", () => {
    const s0 = reachPerform();
    const bad = {
      kind: "perform-beat",
      pauseId: pid(s0),
      voiceOutputs: [
        { instrument: "order", output: "x", confidence: 0.9, producedBy: "Composer" },
      ],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    } as unknown as Resolution;
    const s1 = advance(s0, bad);
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") {
      expect(s1.error).toMatch(/producedBy/);
    }
  });

  test("producedBy persists onto PerformedVoice", () => {
    const s0 = reachPerform();
    const s1 = advance(s0, {
      kind: "perform-beat",
      pauseId: pid(s0),
      voiceOutputs: [
        {
          instrument: "order",
          output: "ok",
          confidence: 0.9,
          producedBy: "maestro-executor",
        },
      ],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    });
    expectPause(s1, "perform-beat");
    if (s1.kind === "running") {
      const recorded = s1.internal.performedBeats[0].voices[0];
      expect(recorded.producedBy).toBe("maestro-executor");
    }
  });
});

// ── Resolution kind mismatch ───────────────────────────────────────

describe("resolution kind mismatch", () => {
  test("submitting wrong-kind resolution fails the engine cleanly", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
    });
    // s0 is paused on confirm-fit but we submit a perform-beat resolution.
    const s1 = advance(s0, {
      kind: "perform-beat",
      pauseId: pid(s0),
      voiceOutputs: [
        { instrument: "order", output: "x", confidence: 0.9, producedBy: "maestro-assessor" },
      ],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    });
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") {
      expect(s1.error).toMatch(/resolution kind/);
    }
  });
});

// ── End-to-end: full investigate run produces valid Performance ────

describe("full run integration", () => {
  test("complete investigate run yields a shape-valid Performance", () => {
    const investigate = getPattern("investigate");
    if (!investigate) {
      throw new Error("investigate pattern not found");
    }
    const beats = investigate.score.beats.length;

    let state = createEngine({
      prompt: "understand the codebase",
      patterns: allPatterns,
      pattern: "investigate",
    });
    state = advance(state, { kind: "confirm-fit", pauseId: pid(state), ok: true });
    state = advance(state, { kind: "go-gate", pauseId: pid(state), phrase: "go" });

    for (let i = 0; i < beats; i += 1) {
      const pause = expectPause(state, "perform-beat");
      expect(pause.payload.beatIndex).toBe(i);
      state = advance(state, {
        kind: "perform-beat",
        pauseId: pid(state),
        voiceOutputs: [
          {
            instrument: pause.payload.beat.voices[0].instrument,
            output: `output for beat ${i}`,
            confidence: 0.85,
            producedBy: "maestro-assessor",
          },
        ],
        verdict: {
          outcome: "applied",
          confidence: 0.85,
          reason: "ok",
          shouldTerminate: false,
        },
      });
    }

    expect(state.kind).toBe("done");
    if (state.kind === "done") {
      const { executableScore, performance } = state.result;
      expect(performance.scoreId).toBe(executableScore.id);
      expect(performance.beats.length).toBe(beats);
      expect(performance.outcome).toBe("success");
      expect(performance.completedAt).not.toBeNull();
      // The footnote bug shape-check: every PerformedBeat has the right keys,
      // and there is NO `schemaVersion` and NO `performedBeats` field.
      performance.beats.forEach((b, i) => {
        expect(b.beatIndex).toBe(i);
        expect(typeof b.stateHash).toBe("string");
        expect(b.verdict?.outcome).toBe("applied");
      });
      expect(Object.keys(performance as unknown as Record<string, unknown>)).toEqual(
        expect.arrayContaining(["scoreId", "beats", "startedAt", "completedAt", "outcome"]),
      );
      expect((performance as unknown as Record<string, unknown>)["schemaVersion"]).toBeUndefined();
      expect((performance as unknown as Record<string, unknown>)["performedBeats"]).toBeUndefined();
    }
  });
});

// ── planOnly + draft-pattern escalation ────────────────────────────

describe("planOnly + escalation", () => {
  test("planOnly=true + go-gate → planned terminal state with algorithm + outPath", () => {
    let state = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
      pattern: "refactor",
      planOnly: true,
      outPath: "/tmp/plan.json",
    } as unknown as Parameters<typeof createEngine>[0]);
    state = advance(state, { kind: "confirm-fit", pauseId: pid(state), ok: true });
    state = advance(state, {
      kind: "elicit-context",
      pauseId: pid(state),
      values: { target: "loadScore", invariant: "imports type-check" },
    });
    expectPause(state, "go-gate");
    state = advance(state, { kind: "go-gate", pauseId: pid(state), phrase: "go" });
    // planOnly short-circuits perform-beat — we should be at `planned`.
    expect(state.kind).toBe("planned");
    if (state.kind === "planned") {
      expect(state.outPath).toBe("/tmp/plan.json");
      expect(state.algorithm.problem).toContain("rename");
      expect(state.algorithm.steps.length).toBeGreaterThan(0);
      expect(state.algorithm.provenance?.pattern).toBe("refactor");
    }
  });

  test("planOnly=false (default) + go-gate → perform-beat (no planned short-circuit)", () => {
    let state = createEngine({
      prompt: "understand the codebase",
      patterns: allPatterns,
      pattern: "investigate",
    });
    state = advance(state, { kind: "confirm-fit", pauseId: pid(state), ok: true });
    state = advance(state, { kind: "go-gate", pauseId: pid(state), phrase: "go" });
    expectPause(state, "perform-beat");
  });

  test("draft-pattern complexity escalates one tier per round when baseHint < 4", () => {
    let state = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
      pattern: "new",
    });
    state = advance(state, {
      kind: "classify-complexity",
      pauseId: pid(state),
      complexity: 2,
    });
    const r1 = expectPause(state, "draft-pattern-round");
    expect(r1.payload.round).toBe(1);
    expect(r1.payload.complexity).toBe(2);
    state = advance(state, { kind: "draft-pattern-round", pauseId: pid(state), outcome: "edit" });
    const r2 = expectPause(state, "draft-pattern-round");
    expect(r2.payload.round).toBe(2);
    expect(r2.payload.complexity).toBe(3); // +1 tier
    state = advance(state, { kind: "draft-pattern-round", pauseId: pid(state), outcome: "edit" });
    const r3 = expectPause(state, "draft-pattern-round");
    expect(r3.payload.round).toBe(3);
    expect(r3.payload.complexity).toBe(4); // +1 tier
    state = advance(state, { kind: "draft-pattern-round", pauseId: pid(state), outcome: "edit" });
    const r4 = expectPause(state, "draft-pattern-round");
    expect(r4.payload.round).toBe(4);
    expect(r4.payload.complexity).toBe(4); // capped at 4
  });

  test("draft-pattern complexity baseHint=4 stays at 4 across rounds (no escalation needed)", () => {
    let state = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
      pattern: "new",
    });
    state = advance(state, {
      kind: "classify-complexity",
      pauseId: pid(state),
      complexity: 4,
    });
    const r1 = expectPause(state, "draft-pattern-round");
    expect(r1.payload.complexity).toBe(4);
    state = advance(state, { kind: "draft-pattern-round", pauseId: pid(state), outcome: "edit" });
    const r2 = expectPause(state, "draft-pattern-round");
    expect(r2.payload.complexity).toBe(4);
  });
});
