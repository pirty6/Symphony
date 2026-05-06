/**
 * perform-runner.test.ts — Tests for the shared batch executor.
 *
 * The runner is the single source of truth for shape validation and
 * outcome derivation: maestro's interactive engine and the
 * `symphony perform` batch command both delegate to it. These tests
 * pin the contract.
 */

import { compileScore } from "../compiler/compile";
import { getPattern } from "../patterns";
import {
  runPerformance,
  validateVerdict,
  validateVoiceOutputs,
  type PerformBeatInput,
} from "./perform-runner";
import type { ExecutableScore } from "./types";

function compileInvestigate(): ExecutableScore {
  const pattern = getPattern("investigate");
  if (!pattern) {
    throw new Error("investigate pattern missing");
  }
  return compileScore(pattern, { problem: "p", context: { goal: "g" } });
}

function appliedInputFor(score: ExecutableScore, beatIndex: number): PerformBeatInput {
  const beat = score.beats[beatIndex];
  return {
    voiceOutputs: beat.voices.map((v) => ({
      instrument: v.instrument,
      output: `output for beat ${beatIndex}`,
      confidence: 0.85,
      producedBy: "maestro-assessor" as const,
    })),
    verdict: { outcome: "applied", confidence: 0.85, reason: "ok", shouldTerminate: false },
  };
}

describe("validateVoiceOutputs", () => {
  test("rejects empty array", () => {
    const score = compileInvestigate();
    expect(validateVoiceOutputs([], score.beats[0])).toMatch(/non-empty array/);
  });

  test("rejects length mismatch with beat.voices", () => {
    const score = compileInvestigate();
    const beat = score.beats[0];
    const tooMany = [
      ...beat.voices.map((v) => ({
        instrument: v.instrument,
        output: "x",
        confidence: 0.5,
        producedBy: "maestro-assessor" as const,
      })),
      {
        instrument: beat.voices[0].instrument,
        output: "extra",
        confidence: 0.5,
        producedBy: "maestro-assessor" as const,
      },
    ];
    expect(validateVoiceOutputs(tooMany, beat)).toMatch(/length/);
  });

  test("rejects unknown instrument", () => {
    const score = compileInvestigate();
    const beat = score.beats[0];
    const bad = beat.voices.map(() => ({
      instrument: "bogus",
      output: "x",
      confidence: 0.5,
      producedBy: "maestro-assessor" as const,
    }));
    expect(validateVoiceOutputs(bad, beat)).toMatch(/is not one of/);
  });

  test("rejects unknown producedBy", () => {
    const score = compileInvestigate();
    const beat = score.beats[0];
    const bad = beat.voices.map((v) => ({
      instrument: v.instrument,
      output: "x",
      confidence: 0.5,
      producedBy: "rogue-agent" as unknown as "maestro-assessor",
    }));
    expect(validateVoiceOutputs(bad, beat)).toMatch(/producedBy/);
  });

  test("accepts confidence exactly 0 (boundary)", () => {
    const score = compileInvestigate();
    const beat = score.beats[0];
    const ok = beat.voices.map((v) => ({
      instrument: v.instrument,
      output: "x",
      confidence: 0,
      producedBy: "maestro-assessor" as const,
    }));
    expect(validateVoiceOutputs(ok, beat)).toBeUndefined();
  });

  test("accepts confidence exactly 1 (boundary)", () => {
    const score = compileInvestigate();
    const beat = score.beats[0];
    const ok = beat.voices.map((v) => ({
      instrument: v.instrument,
      output: "x",
      confidence: 1,
      producedBy: "maestro-assessor" as const,
    }));
    expect(validateVoiceOutputs(ok, beat)).toBeUndefined();
  });

  test("rejects missing producedBy field", () => {
    const score = compileInvestigate();
    const beat = score.beats[0];
    const bad = beat.voices.map((v) => ({
      instrument: v.instrument,
      output: "x",
      confidence: 0.5,
      // producedBy intentionally omitted
    })) as unknown as Parameters<typeof validateVoiceOutputs>[0];
    expect(validateVoiceOutputs(bad, beat)).toMatch(/producedBy/);
  });

  test("rejects NaN confidence", () => {
    const score = compileInvestigate();
    const beat = score.beats[0];
    const bad = beat.voices.map((v) => ({
      instrument: v.instrument,
      output: "x",
      confidence: Number.NaN,
      producedBy: "maestro-assessor" as const,
    }));
    expect(validateVoiceOutputs(bad, beat)).toMatch(/confidence/);
  });

  test("rejects empty-string instrument", () => {
    const score = compileInvestigate();
    const beat = score.beats[0];
    const bad = beat.voices.map(() => ({
      instrument: "",
      output: "x",
      confidence: 0.5,
      producedBy: "maestro-assessor" as const,
    }));
    expect(validateVoiceOutputs(bad, beat)).toMatch(/non-empty string/);
  });
});

describe("validateVerdict", () => {
  test("rejects out-of-range confidence", () => {
    expect(
      validateVerdict({
        outcome: "applied",
        confidence: 1.5,
        reason: "x",
        shouldTerminate: false,
      }),
    ).toMatch(/confidence/);
  });

  test("rejects bogus outcome", () => {
    expect(
      validateVerdict({
        outcome: "bogus" as unknown as "applied",
        confidence: 0.5,
        reason: "x",
        shouldTerminate: false,
      }),
    ).toMatch(/outcome/);
  });
});

describe("runPerformance batch executor", () => {
  test("happy path: full inputs → outcome=success, all beats recorded", () => {
    const score = compileInvestigate();
    const inputs = score.beats.map((_, i) => appliedInputFor(score, i));
    const result = runPerformance(score, inputs);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.performance.outcome).toBe("success");
      expect(result.performance.beats).toHaveLength(score.beats.length);
      expect(result.performance.scoreId).toBe(score.id);
      expect(result.performance.completedAt).toBeDefined();
    }
  });

  test("short inputs without shouldTerminate → failed (no silent partial)", () => {
    const score = compileInvestigate();
    const inputs = [appliedInputFor(score, 0), appliedInputFor(score, 1)];
    const result = runPerformance(score, inputs);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.beatIndex).toBe(2);
      expect(result.error).toMatch(/exhausted/);
    }
  });

  test("shouldTerminate=true mid-array stops execution and yields a Performance", () => {
    const score = compileInvestigate();
    const earlyStop: PerformBeatInput = {
      voiceOutputs: score.beats[0].voices.map((v) => ({
        instrument: v.instrument,
        output: "stopping early",
        confidence: 0.9,
        producedBy: "maestro-assessor" as const,
      })),
      verdict: {
        outcome: "applied",
        confidence: 0.9,
        reason: "done",
        shouldTerminate: true,
      },
    };
    const result = runPerformance(score, [earlyStop]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.performance.beats).toHaveLength(1);
      expect(result.performance.outcome).toBe("success");
    }
  });

  test("all-skipped run → outcome=partial (matches engine guard)", () => {
    const score = compileInvestigate();
    const inputs = score.beats.map((beat, i) => ({
      voiceOutputs: beat.voices.map((v) => ({
        instrument: v.instrument,
        output: `n/a beat ${i}`,
        confidence: 0.1,
        producedBy: "maestro-assessor" as const,
      })),
      verdict: {
        outcome: "skipped" as const,
        confidence: 0.1,
        reason: "n/a",
        shouldTerminate: false,
      },
    }));
    const result = runPerformance(score, inputs);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.performance.outcome).toBe("partial");
    }
  });

  test("inputs longer than score.beats → failed", () => {
    const score = compileInvestigate();
    const tooMany = [
      ...score.beats.map((_, i) => appliedInputFor(score, i)),
      appliedInputFor(score, 0),
    ];
    const result = runPerformance(score, tooMany);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error).toMatch(/inputs length/);
    }
  });

  test("invalid voiceOutputs aborts at the offending beat", () => {
    const score = compileInvestigate();
    const beat0Bad: PerformBeatInput = {
      voiceOutputs: [],
      verdict: {
        outcome: "applied",
        confidence: 0.5,
        reason: "ok",
        shouldTerminate: false,
      },
    };
    const result = runPerformance(score, [beat0Bad]);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.beatIndex).toBe(0);
      expect(result.error).toMatch(/non-empty/);
    }
  });
});
