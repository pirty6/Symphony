/**
 * meta-score.test.ts — Structural + behavioral tests for the meta-score.
 */

import {
  runMetaScore,
  resetInvocationCount,
} from "./meta-score";
import * as prompts from "./prompts";

beforeEach(() => {
  resetInvocationCount();
});

// ── Structural Tests ───────────────────────────────────────────────

describe("Structural: prompt pairing", () => {
  const promptFns = Object.keys(prompts);
  const composers = promptFns
    .filter((name) => name.endsWith("Composer"))
    .map((name) => name.replace(/Composer$/, ""));
  const instruments = promptFns
    .filter((name) => name.endsWith("Instrument"))
    .map((name) => name.replace(/Instrument$/, ""));

  test("every Composer has a matching Instrument", () => {
    for (const name of composers) {
      expect(instruments).toContain(name);
    }
  });

  test("every Instrument has a matching Composer", () => {
    for (const name of instruments) {
      expect(composers).toContain(name);
    }
  });

  test("no orphan prompts", () => {
    expect(composers.sort()).toEqual(instruments.sort());
  });
});

describe("Structural: non-empty prompts", () => {
  const promptFns = Object.entries(prompts) as Array<[string, () => string]>;

  test.each(promptFns)("%s returns non-empty string", (_name, fn) => {
    const result = fn();
    expect(typeof result).toBe("string");
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

describe("Structural: ALLOWED TOOLS in instrument prompts", () => {
  const instrumentFns = Object.entries(prompts).filter(
    ([name]) => name.endsWith("Instrument"),
  ) as Array<[string, () => string]>;

  test.each(instrumentFns)("%s declares ALLOWED TOOLS", (_name, fn) => {
    expect(fn()).toContain("ALLOWED TOOLS:");
  });
});

// ── Behavioral Tests ───────────────────────────────────────────────

describe("Behavioral: meta-score state machine", () => {
  test("exits 1 when goal is missing", () => {
    const result = runMetaScore({ goal: "" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("META_SCORE_ERROR");
  });

  test("exits 2 on phase 1 (goal clarification) for new goal", () => {
    const result = runMetaScore({ goal: "add real-time collaboration" });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: goal-clarification");
    expect(result.output).toContain("COMPOSER_INSTRUCTIONS_BEGIN");
    expect(result.output).toContain("INSTRUMENT_INSTRUCTIONS_BEGIN");
  });

  test("advances past phase 1 when goal is confirmed", () => {
    const result = runMetaScore({
      goal: "add real-time collaboration",
      goalConfirmed: "add real-time collaboration to the editor",
      successCondition: "two users can edit the same document simultaneously",
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: constraint-mapping");
  });

  test("advances past phase 2 when constraints are confirmed", () => {
    const result = runMetaScore({
      goal: "add real-time collaboration",
      goalConfirmed: "add real-time collaboration to the editor",
      successCondition: "two users can edit simultaneously",
      constraintsConfirmed: "true",
      invariants: "public API",
      degreesOfFreedom: "internal implementation",
      qualityCriteria: "no new dependencies",
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: problem-classification");
  });

  test("advances past phase 3 when problem is classified", () => {
    const result = runMetaScore({
      goal: "add real-time collaboration",
      goalConfirmed: "confirmed",
      successCondition: "two users can edit simultaneously",
      constraintsConfirmed: "true",
      invariants: "public API",
      degreesOfFreedom: "internal",
      qualityCriteria: "clean",
      problemClass: "BEHAVIORAL:SYSTEMIC:NOVEL",
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: strategy-discovery");
    expect(result.output).toContain("PROBLEM_CLASS=BEHAVIORAL:SYSTEMIC:NOVEL");
  });

  test("advances past phase 4 when strategies are discovered", () => {
    const result = runMetaScore({
      goal: "add real-time collaboration",
      goalConfirmed: "confirmed",
      successCondition: "two users can edit simultaneously",
      constraintsConfirmed: "true",
      invariants: "public API",
      degreesOfFreedom: "internal",
      qualityCriteria: "clean",
      problemClass: "BEHAVIORAL:SYSTEMIC:NOVEL",
      strategiesRaw: "feature-flag|extend-state|replace-state",
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: strategy-ordering");
  });

  test("advances past phase 5 when strategies are ordered", () => {
    const result = runMetaScore({
      goal: "add real-time collaboration",
      goalConfirmed: "confirmed",
      successCondition: "two users can edit simultaneously",
      constraintsConfirmed: "true",
      problemClass: "BEHAVIORAL:SYSTEMIC:NOVEL",
      strategiesRaw: "feature-flag|extend-state|replace-state",
      strategiesOrdered: "feature-flag|extend-state|replace-state",
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: verify-hook-definition");
  });

  test("advances to spec review when all phases complete", () => {
    const result = runMetaScore({
      goal: "add real-time collaboration",
      goalConfirmed: "confirmed",
      successCondition: "two users can edit simultaneously",
      constraintsConfirmed: "true",
      problemClass: "BEHAVIORAL:SYSTEMIC:NOVEL",
      strategiesRaw: "feature-flag|extend-state",
      strategiesOrdered: "feature-flag|extend-state",
      verifyHookConfirmed: "true",
      problemHooks: '[{"verify":"npm test"}]',
      strategyHooks: '[{"strategy":"feature-flag","verify":"test passes"}]',
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: spec-review");
    expect(result.output).toContain("SPEC_BEGIN");
    expect(result.output).toContain("HUMAN_REVIEW_REQUIRED");
  });

  test("advances to score generation when spec is approved", () => {
    const result = runMetaScore({
      goal: "add real-time collaboration",
      goalConfirmed: "confirmed",
      successCondition: "two users can edit simultaneously",
      constraintsConfirmed: "true",
      problemClass: "BEHAVIORAL:SYSTEMIC:NOVEL",
      strategiesRaw: "feature-flag|extend-state",
      strategiesOrdered: "feature-flag|extend-state",
      verifyHookConfirmed: "true",
      problemHooks: '[{"verify":"npm test"}]',
      strategyHooks: '[{"strategy":"feature-flag","verify":"test passes"}]',
      specApproved: "true",
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: score-generation");
    expect(result.output).toContain("SPEC_APPROVED=true");
  });

  test("advances to execution gate after score generation is approved", () => {
    const result = runMetaScore({
      goal: "add real-time collaboration",
      goalConfirmed: "confirmed",
      successCondition: "two users can edit simultaneously",
      constraintsConfirmed: "true",
      problemClass: "BEHAVIORAL:SYSTEMIC:NOVEL",
      strategiesRaw: "feature-flag|extend-state",
      strategiesOrdered: "feature-flag|extend-state",
      verifyHookConfirmed: "true",
      problemHooks: '[{"verify":"npm test"}]',
      strategyHooks: '[{"strategy":"feature-flag","verify":"test passes"}]',
      specApproved: "true",
      scoreGenerated: "true",
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: score-execution");
  });

  test("exits 0 when execution is approved", () => {
    const result = runMetaScore({
      goal: "add real-time collaboration",
      goalConfirmed: "confirmed",
      successCondition: "two users can edit simultaneously",
      constraintsConfirmed: "true",
      problemClass: "BEHAVIORAL:SYSTEMIC:NOVEL",
      strategiesRaw: "feature-flag|extend-state",
      strategiesOrdered: "feature-flag|extend-state",
      verifyHookConfirmed: "true",
      problemHooks: '[{"verify":"npm test"}]',
      strategyHooks: '[{"strategy":"feature-flag","verify":"test passes"}]',
      specApproved: "true",
      scoreGenerated: "true",
      executionApproved: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("META_SCORE_COMPLETE");
  });

  test("exits 1 on max invocations exceeded", () => {
    for (let i = 0; i < 16; i++) {
      runMetaScore({ goal: "test" });
    }
    const result = runMetaScore({ goal: "test" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Max invocations");
  });
});
