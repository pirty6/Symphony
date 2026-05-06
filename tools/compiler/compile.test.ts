/**
 * compile.test.ts — compileScore + parseAlgorithm.
 *
 * Covers the deterministic shape conversion at the heart of Symphony:
 * required-context validation, directive copy-through, frequencyMap
 * derivation, deterministic id, and parseAlgorithm error paths.
 */

import { compileScore, parseAlgorithm, type AlgorithmInput } from "./compile";
import { investigatePattern, refactorPattern, featurePattern } from "../patterns";
import { LEVEL_ACTIVITY_THRESHOLD, LEVELS } from "../symphony/types";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

describe("compileScore", () => {
  test("compiles investigate (no required context)", () => {
    const score = compileScore(investigatePattern, {
      problem: "investigate logging duplication",
      generatedAt: FIXED_TS,
    });
    expect(score.schemaVersion).toBe(1);
    expect(score.pattern).toBe("investigate");
    expect(score.beats.length).toBe(investigatePattern.score.beats.length);
    expect(score.generatedAt).toBe(FIXED_TS);
    expect(score.id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("copies static directives verbatim", () => {
    const score = compileScore(investigatePattern, { problem: "x", generatedAt: FIXED_TS });
    score.beats.forEach((beat, i) => {
      const pb = investigatePattern.score.beats[i];
      expect(beat.directive).toBe(pb.directive);
      expect(beat.level).toBe(pb.level);
      expect(beat.voices).toEqual([{ instrument: pb.instrument }]);
    });
  });

  test("derives frequencyMap from beat histogram with all 8 levels present", () => {
    const score = compileScore(investigatePattern, { problem: "x", generatedAt: FIXED_TS });
    const total = score.beats.length;
    const counts = score.beats.reduce<Record<number, number>>((acc, b) => {
      acc[b.level] = (acc[b.level] ?? 0) + 1;
      return acc;
    }, {});
    for (const lvl of score.frequencyMap.activeLevels) {
      const share = total === 0 ? 0 : (counts[lvl] ?? 0) / total;
      expect(share).toBeGreaterThanOrEqual(LEVEL_ACTIVITY_THRESHOLD);
    }
    for (const lvl of LEVELS) {
      const share = total === 0 ? 0 : (counts[lvl] ?? 0) / total;
      const isActive = score.frequencyMap.activeLevels.includes(lvl);
      expect(isActive).toBe(share >= LEVEL_ACTIVITY_THRESHOLD);
    }
  });

  test("compiles refactor with both required keys", () => {
    const score = compileScore(refactorPattern, {
      problem: "rename Score → ExecutableScore",
      context: { target: "Score interface", invariant: "all imports still type-check" },
      generatedAt: FIXED_TS,
    });
    expect(score.pattern).toBe("refactor");
    expect(score.context).toEqual({
      target: "Score interface",
      invariant: "all imports still type-check",
    });
  });

  test("rejects refactor with missing target", () => {
    expect(() =>
      compileScore(refactorPattern, {
        problem: "x",
        context: { invariant: "i" },
        generatedAt: FIXED_TS,
      }),
    ).toThrow(/requires context\.target/);
  });

  test("rejects refactor with empty invariant string", () => {
    expect(() =>
      compileScore(refactorPattern, {
        problem: "x",
        context: { target: "t", invariant: "   " },
        generatedAt: FIXED_TS,
      }),
    ).toThrow(/requires context\.invariant/);
  });

  test("rejects feature with no context at all", () => {
    expect(() =>
      compileScore(featurePattern, { problem: "x", generatedAt: FIXED_TS }),
    ).toThrow(/requires context\.scope/);
  });

  test("id is deterministic across calls (excluding generatedAt)", () => {
    const a = compileScore(refactorPattern, {
      problem: "p",
      context: { target: "t", invariant: "i" },
      generatedAt: FIXED_TS,
    });
    const b = compileScore(refactorPattern, {
      problem: "p",
      context: { target: "t", invariant: "i" },
      generatedAt: "2099-12-31T00:00:00.000Z",
    });
    expect(a.id).toBe(b.id);
  });

  test("id changes when context changes", () => {
    const a = compileScore(refactorPattern, {
      problem: "p",
      context: { target: "t1", invariant: "i" },
      generatedAt: FIXED_TS,
    });
    const b = compileScore(refactorPattern, {
      problem: "p",
      context: { target: "t2", invariant: "i" },
      generatedAt: FIXED_TS,
    });
    expect(a.id).not.toBe(b.id);
  });

  test("id changes when problem changes (different fingerprint)", () => {
    const a = compileScore(refactorPattern, {
      problem: "p1",
      context: { target: "t", invariant: "i" },
      generatedAt: FIXED_TS,
    });
    const b = compileScore(refactorPattern, {
      problem: "p2",
      context: { target: "t", invariant: "i" },
      generatedAt: FIXED_TS,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.generatedFrom.canonicalHash).not.toBe(b.generatedFrom.canonicalHash);
  });
});

describe("parseAlgorithm", () => {
  const minimal: AlgorithmInput = {
    problem: "p",
    domain: "test",
    steps: [
      { verb: "scope", directive: "Scope it." },
      { verb: "do", directive: "Do it." },
    ],
    annotations: [
      { verb: "scope", level: 3, instrument: "order" },
      { verb: "do", level: 4, instrument: "decide" },
    ],
  };

  test("emits a Score with no pattern field", () => {
    const score = parseAlgorithm({ ...minimal, generatedAt: FIXED_TS });
    expect(score.pattern).toBeUndefined();
    expect(score.context).toBeUndefined();
    expect(score.beats.length).toBe(2);
  });

  test("rejects empty steps", () => {
    expect(() => parseAlgorithm({ ...minimal, steps: [] })).toThrow(/empty/);
  });

  test("rejects step with no matching annotation", () => {
    expect(() =>
      parseAlgorithm({
        ...minimal,
        steps: [...minimal.steps, { verb: "missing", directive: "x" }],
      }),
    ).toThrow(/no matching annotation/);
  });

  test("rejects orphan annotation with no matching step", () => {
    expect(() =>
      parseAlgorithm({
        ...minimal,
        annotations: [
          ...minimal.annotations,
          { verb: "ghost", level: 1, instrument: "analyze" },
        ],
      }),
    ).toThrow(/no matching step/);
  });

  test("rejects duplicate annotation verbs", () => {
    expect(() =>
      parseAlgorithm({
        ...minimal,
        annotations: [
          ...minimal.annotations,
          { verb: "scope", level: 5, instrument: "integrate" },
        ],
      }),
    ).toThrow(/duplicate annotation/);
  });
});

describe("compile-time legality", () => {
  // The legality matrix lives in tools/symphony/legality.ts. Illegal pairs
  // include (level=1, instrument=question), (level=1, instrument=integrate),
  // (level=7, instrument=order), (level=8, instrument=order). The compiler
  // rejects these at generation time so authoring mistakes surface where
  // they were made, not later at score-load time.

  test("parseAlgorithm rejects an illegal (1, question) beat", () => {
    expect(() =>
      parseAlgorithm({
        problem: "p",
        domain: "test",
        steps: [{ verb: "explore", directive: "explore raw artifact" }],
        annotations: [{ verb: "explore", level: 1, instrument: "question" }],
        generatedAt: FIXED_TS,
      }),
    ).toThrow(/parseAlgorithm.*illegal.*level=1.*question/);
  });

  test("parseAlgorithm rejects an illegal (8, order) beat", () => {
    expect(() =>
      parseAlgorithm({
        problem: "p",
        domain: "test",
        steps: [{ verb: "sequence", directive: "sequence first principles" }],
        annotations: [{ verb: "sequence", level: 8, instrument: "order" }],
        generatedAt: FIXED_TS,
      }),
    ).toThrow(/parseAlgorithm.*illegal.*level=8.*order/);
  });

  test("compileScore rejects a synthesized pattern with an illegal beat", () => {
    // Build a one-off pattern with a deliberately illegal (1, integrate) beat.
    const illegalPattern = {
      score: {
        pattern: "illegal-test",
        domain: "test",
        beats: [
          {
            step: "merge",
            level: 1 as const,
            instrument: "integrate" as const,
            directive: "merge raw artifacts",
          },
        ],
      },
      description: "synthetic illegal pattern for testing",
      requiredContext: [] as readonly string[],
    };
    expect(() =>
      compileScore(illegalPattern, { problem: "p", generatedAt: FIXED_TS }),
    ).toThrow(/compileScore.*illegal.*level=1.*integrate/);
  });

  test("error message includes the legality rationale when known", () => {
    expect(() =>
      parseAlgorithm({
        problem: "p",
        domain: "test",
        steps: [{ verb: "ask", directive: "ask the artifact" }],
        annotations: [{ verb: "ask", level: 1, instrument: "question" }],
        generatedAt: FIXED_TS,
      }),
    ).toThrow(/exploration has no surface area/);
  });

  test("compileScore still accepts every registered pattern (no regressions)", () => {
    expect(() =>
      compileScore(investigatePattern, { problem: "p", generatedAt: FIXED_TS }),
    ).not.toThrow();
    expect(() =>
      compileScore(refactorPattern, {
        problem: "p",
        context: { target: "t", invariant: "i" },
        generatedAt: FIXED_TS,
      }),
    ).not.toThrow();
    expect(() =>
      compileScore(featurePattern, {
        problem: "p",
        context: { contract: "c", scope: "s" },
        generatedAt: FIXED_TS,
      }),
    ).not.toThrow();
  });
});
