/**
 * engine.test.ts — Maestro engine state-machine tests.
 *
 * The engine is a pure reducer: createEngine + advance. These tests
 * pin every gate that, in the previous markdown-only maestro, an LLM
 * could (and did) skip:
 *
 *   - verb-match routing                          → must produce match-pattern pause
 *   - confirm-fit reroute                         → re-enters phase 1 cleanly
 *   - elicit-context refuses empty values         → footnote-class control-flow gate
 *   - go-gate refuses vague positive language     → only canonical phrases advance
 *   - draft-pattern hard MAX_ROUNDS=6             → terminal failure, no backdoor
 *   - perform-beat shape validation               → THE footnote bug
 *   - completed Performance has correct shape     → integration with scaffoldPerformance
 */

import {
  createEngine,
  advance,
  MAESTRO_GO_PHRASES,
  type Pause,
  type Resolution,
} from "./engine";
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
        state.kind === "failed" ? state.error : "done"
      }`,
    );
  }
  if (state.pause.kind !== kind) {
    throw new Error(
      `expected pause '${kind}', got '${state.pause.kind}'`,
    );
  }
  return state.pause as Extract<Pause, { kind: K }>;
}

// ── Phase 1: match-pattern ─────────────────────────────────────────

describe("match-pattern routing", () => {
  test("single verb match auto-advances to confirm-fit", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
    });
    // 'rename' uniquely matches refactor → engine skips match-pattern pause.
    expectPause(s0, "confirm-fit");
  });

  test("ambiguous prompt produces match-pattern pause with all candidates", () => {
    const s0 = createEngine({
      // 'add' matches feature; 'understand' matches investigate. Two candidates.
      prompt: "understand and add a debounce to the input field",
      patterns: allPatterns,
    });
    const pause = expectPause(s0, "match-pattern");
    const names = pause.payload.candidates.map((c) => c.pattern).sort();
    expect(names).toEqual(["feature", "investigate"]);
  });

  test("no verb match transitions straight into draft-pattern-round 1", () => {
    const s0 = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
    });
    const pause = expectPause(s0, "draft-pattern-round");
    expect(pause.payload.round).toBe(1);
    expect(pause.payload.priorDraft).toBeNull();
  });
});

// ── Phase 1: confirm-fit ───────────────────────────────────────────

describe("confirm-fit", () => {
  test("ok=true advances to elicit-context", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
    });
    const s1 = advance(s0, { kind: "confirm-fit", ok: true });
    const pause = expectPause(s1, "elicit-context");
    expect(pause.payload.pattern).toBe("refactor");
    expect(pause.payload.missingKeys).toEqual(["target", "invariant"]);
  });

  test("ok=false with reroute name emits a fresh confirm-fit on the new pattern", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
    });
    const s1 = advance(s0, {
      kind: "confirm-fit",
      ok: false,
      reroute: "investigate",
    });
    // Reroute does NOT skip confirm-fit — a typo'd reroute name would crash
    // silently otherwise. User must explicitly accept the new fit.
    const pause = expectPause(s1, "confirm-fit");
    expect(pause.payload.pattern).toBe("investigate");
  });

  test("ok=false without reroute re-emits match-pattern listing all patterns", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
    });
    const s1 = advance(s0, { kind: "confirm-fit", ok: false });
    // User said wrong pattern but doesn't yet know which. Engine offers
    // every registered pattern as a candidate (or 'no-match' to draft).
    const pause = expectPause(s1, "match-pattern");
    const names = pause.payload.candidates.map((c) => c.pattern).sort();
    expect(names).toEqual(["feature", "investigate", "refactor"]);
  });

  test("reroute to unknown pattern fails the engine", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
    });
    const s1 = advance(s0, {
      kind: "confirm-fit",
      ok: false,
      reroute: "nonexistent-pattern",
    });
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") expect(s1.error).toMatch(/reroute target/);
  });
});

// ── Phase 2: elicit-context ────────────────────────────────────────

describe("elicit-context", () => {
  function reachElicit(): ReturnType<typeof createEngine> {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
    });
    return advance(s0, { kind: "confirm-fit", ok: true });
  }

  test("empty value re-emits elicit-context with key still missing", () => {
    const s0 = reachElicit();
    const s1 = advance(s0, {
      kind: "elicit-context",
      values: { target: "", invariant: "imports type-check" },
    });
    const pause = expectPause(s1, "elicit-context");
    expect(pause.payload.missingKeys).toEqual(["target"]);
  });

  test("whitespace-only value treated as empty", () => {
    const s0 = reachElicit();
    const s1 = advance(s0, {
      kind: "elicit-context",
      values: { target: "   ", invariant: "imports type-check" },
    });
    const pause = expectPause(s1, "elicit-context");
    expect(pause.payload.missingKeys).toContain("target");
  });

  test("all keys filled advances to go-gate", () => {
    const s0 = reachElicit();
    const s1 = advance(s0, {
      kind: "elicit-context",
      values: { target: "rename loadScore", invariant: "imports type-check" },
    });
    expectPause(s1, "go-gate");
  });

  test("extra unknown keys are dropped silently (forward-compat)", () => {
    const s0 = reachElicit();
    const s1 = advance(s0, {
      kind: "elicit-context",
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
    });
    const s1 = advance(s0, { kind: "confirm-fit", ok: true });
    return advance(s1, {
      kind: "elicit-context",
      values: { target: "rename loadScore", invariant: "imports type-check" },
    });
  }

  test.each(MAESTRO_GO_PHRASES)("'%s' advances to perform-beat 0", (phrase) => {
    const s0 = reachGate();
    const s1 = advance(s0, { kind: "go-gate", phrase });
    const pause = expectPause(s1, "perform-beat");
    expect(pause.payload.beatIndex).toBe(0);
  });

  test.each([
    "sounds fine-ish",
    "yeah maybe",
    "ok i guess",
    "fine",
    "yes please",
    "",
    "  ",
  ])("vague phrase '%s' re-emits go-gate", (phrase) => {
    const s0 = reachGate();
    const s1 = advance(s0, { kind: "go-gate", phrase });
    expectPause(s1, "go-gate");
  });

  test("phrase match is case-insensitive and trims whitespace", () => {
    const s0 = reachGate();
    const s1 = advance(s0, { kind: "go-gate", phrase: "  GO  " });
    expectPause(s1, "perform-beat");
  });
});

// ── Phase 1.3: draft-pattern hard cap ──────────────────────────────

describe("draft-pattern MAX_ROUNDS", () => {
  function makeStubPattern(name: string): Pattern {
    return {
      score: {
        pattern: name,
        domain: "feature",
        defaultComplexity: 2,
        defaultShape: "layered",
        beats: [
          {
            step: "stub",
            level: 3,
            instrument: "piano",
            directive: "stub directive",
          },
        ],
      },
      verbTriggers: [name],
      requiredContext: [],
    };
  }

  test("terminates at round 6 with failed engine state", () => {
    let state = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
    });
    for (let i = 0; i < 6; i++) {
      const pause = expectPause(state, "draft-pattern-round");
      expect(pause.payload.round).toBe(i + 1);
      state = advance(state, {
        kind: "draft-pattern-round",
        outcome: "edit",
      });
    }
    // 7th iteration should be terminal failure.
    expect(state.kind).toBe("failed");
    if (state.kind === "failed") {
      expect(state.error).toMatch(/MAX_ROUNDS/);
    }
  });

  test("approve at round 1 transitions out of debate", () => {
    const s0 = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
    });
    expectPause(s0, "draft-pattern-round");
    const s1 = advance(s0, {
      kind: "draft-pattern-round",
      outcome: "approve",
      nextDraft: makeStubPattern("frobnicate"),
    });
    // After approval, engine treats the new pattern as the active one
    // and proceeds to confirm-fit (or elicit-context if no requiredContext).
    expect(["confirm-fit", "go-gate"]).toContain(
      s1.kind === "running" ? s1.pause.kind : "",
    );
  });
});

// ── Phase 3: perform-beat shape validation (the footnote bug) ──────

describe("perform-beat shape validation", () => {
  function reachPerform(): ReturnType<typeof createEngine> {
    const s0 = createEngine({
      prompt: "understand the architecture",
      patterns: allPatterns,
    });
    // 'understand' uniquely matches investigate (no requiredContext).
    const s1 = advance(s0, { kind: "confirm-fit", ok: true });
    return advance(s1, { kind: "go-gate", phrase: "go" });
  }

  test("valid voice output advances to next beat", () => {
    const s0 = reachPerform();
    const pause0 = expectPause(s0, "perform-beat");
    expect(pause0.payload.beatIndex).toBe(0);
    const s1 = advance(s0, {
      kind: "perform-beat",
      voiceOutputs: [
        { instrument: "percussion", output: "restated", confidence: 0.9 },
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
    const s1 = advance(s0, {
      kind: "perform-beat",
      // @ts-expect-error intentional bad shape
      voiceOutputs: [{ output: "x", confidence: 0.9 }],
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "ok",
        shouldTerminate: false,
      },
    });
    expect(s1.kind).toBe("failed");
    if (s1.kind === "failed") expect(s1.error).toMatch(/voice/i);
  });

  test("non-string output → engine fails", () => {
    const s0 = reachPerform();
    const s1 = advance(s0, {
      kind: "perform-beat",
      voiceOutputs: [
        // @ts-expect-error intentional bad shape
        { instrument: "percussion", output: 42, confidence: 0.9 },
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

  test("confidence out of [0,1] → engine fails", () => {
    const s0 = reachPerform();
    const s1 = advance(s0, {
      kind: "perform-beat",
      voiceOutputs: [
        { instrument: "percussion", output: "x", confidence: 1.5 },
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
      voiceOutputs: [
        { instrument: "percussion", output: "couldnt", confidence: 0.2 },
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
    });
    const roundTripped = JSON.parse(JSON.stringify(s0)) as typeof s0;
    expect(roundTripped.kind).toBe("running");
    // Advance the round-tripped state.
    const s1 = advance(roundTripped, { kind: "confirm-fit", ok: true });
    expectPause(s1, "elicit-context");
  });

  test("perform-beat state survives JSON round-trip mid-execution", () => {
    let state = createEngine({
      prompt: "understand the codebase",
      patterns: allPatterns,
    });
    state = advance(state, { kind: "confirm-fit", ok: true });
    state = advance(state, { kind: "go-gate", phrase: "go" });
    // mid-run round-trip
    state = JSON.parse(JSON.stringify(state)) as typeof state;
    expectPause(state, "perform-beat");
    state = advance(state, {
      kind: "perform-beat",
      voiceOutputs: [
        { instrument: "percussion", output: "ok", confidence: 0.9 },
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

// ── Debate complexity hint ─────────────────────────────────────────

describe("debateComplexityHint", () => {
  test("createEngine without hint defaults round 1 to complexity 2", () => {
    const s0 = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
    });
    const pause = expectPause(s0, "draft-pattern-round");
    expect(pause.payload.debateComplexity).toBe(2);
  });

  test("hint=4 makes round 1 complexity 4 (capped)", () => {
    const s0 = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
      debateComplexityHint: 4,
    });
    const pause = expectPause(s0, "draft-pattern-round");
    expect(pause.payload.debateComplexity).toBe(4);
  });

  test("hint=1 starts at 1 and escalates each round, capped at 4", () => {
    let state = createEngine({
      prompt: "frobnicate the widget cluster",
      patterns: allPatterns,
      debateComplexityHint: 1,
    });
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const pause = expectPause(state, "draft-pattern-round");
      seen.push(pause.payload.debateComplexity);
      state = advance(state, { kind: "draft-pattern-round", outcome: "edit" });
    }
    expect(seen).toEqual([1, 2, 3, 4, 4, 4]);
  });
});

// ── Resolution kind mismatch ───────────────────────────────────────

describe("resolution kind mismatch", () => {
  test("submitting wrong-kind resolution fails the engine cleanly", () => {
    const s0 = createEngine({
      prompt: "rename loadScore to loadExecutableScore",
      patterns: allPatterns,
    });
    // s0 is paused on confirm-fit but we submit a perform-beat resolution.
    const s1 = advance(s0, {
      kind: "perform-beat",
      voiceOutputs: [
        { instrument: "percussion", output: "x", confidence: 0.9 },
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
    const investigate = getPattern("investigate")!;
    const beats = investigate.score.beats.length;

    let state = createEngine({
      prompt: "understand the codebase",
      patterns: allPatterns,
    });
    state = advance(state, { kind: "confirm-fit", ok: true });
    state = advance(state, { kind: "go-gate", phrase: "go" });

    for (let i = 0; i < beats; i++) {
      const pause = expectPause(state, "perform-beat");
      expect(pause.payload.beatIndex).toBe(i);
      state = advance(state, {
        kind: "perform-beat",
        voiceOutputs: [
          {
            instrument: pause.payload.beat.voices[0].instrument,
            output: `output for beat ${i}`,
            confidence: 0.85,
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
      expect(
        Object.keys(performance as unknown as Record<string, unknown>),
      ).toEqual(
        expect.arrayContaining(["scoreId", "beats", "startedAt", "completedAt", "outcome"]),
      );
      expect(
        (performance as unknown as Record<string, unknown>)["schemaVersion"],
      ).toBeUndefined();
      expect(
        (performance as unknown as Record<string, unknown>)["performedBeats"],
      ).toBeUndefined();
    }
  });
});
