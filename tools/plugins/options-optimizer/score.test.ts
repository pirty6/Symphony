import {
  PHASE_ORDER,
  runScore,
  InvalidScoreInputError,
  type ScorePhase,
} from "./score";
import {
  clearShapeRegistry,
  registerShape,
  listShapes,
  hasShape,
  UnknownShapeError,
  DuplicateShapeError,
} from "./shapes";
import type { Shape } from "./shapes";
import type { EvaluatedStrategy, StrategySpec } from "./options-optimizer";
import { putSpreadHedgeShape } from "./shapes/put-spread-hedge";

// Most tests assume the default registry (put-spread-hedge auto-registered).
// Tests that mutate the registry restore it via afterEach.

function ensureDefaultRegistry(): void {
  clearShapeRegistry();
  registerShape(putSpreadHedgeShape);
}

beforeEach(() => {
  ensureDefaultRegistry();
});

describe("score: phase order", () => {
  test("phase ordering matches the algorithm-of-algorithms loop", () => {
    expect(PHASE_ORDER).toEqual([
      "formalize",
      "classify",
      "catalog",
      "order",
      "execute",
      "halt",
      "rank",
      "emit",
    ] satisfies readonly ScorePhase[]);
  });
});

describe("score: shape registry", () => {
  test("registers default put-spread-hedge shape on import", () => {
    expect(hasShape("put-spread-hedge")).toBe(true);
    expect(listShapes()).toContain("put-spread-hedge");
  });

  test("rejects duplicate shape registration", () => {
    expect(() => registerShape(putSpreadHedgeShape)).toThrow(DuplicateShapeError);
  });

  test("score emits exit 1 when an unknown shape is requested", () => {
    const result = runScore({
      capital: 100_000,
      maxLossPct: 20,
      seed: 1,
      iterations: 50,
      shapeName: "iron-condor",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/UnknownShapeError/);
  });

  test("score emits exit 2 (judgment) when registry is empty", () => {
    clearShapeRegistry();
    const result = runScore({
      capital: 100_000,
      maxLossPct: 20,
      seed: 1,
      iterations: 50,
    });
    expect(result.exitCode).toBe(2);
    expect(result.judgment?.type).toBe("shape-registration");
    expect(result.output).toContain("COMPOSER_INSTRUCTIONS_BEGIN");
    expect(result.output).toContain("INSTRUMENT_INSTRUCTIONS_BEGIN");
  });

  test("a brand new shape can be added without touching score.ts", () => {
    const fakeSpec: StrategySpec = {
      aaplLongPutStrike: 200,
      aaplShortPutStrike: 190,
      hedgeInstrument: "xle-shares",
      aaplAllocationPct: 50,
      xleAllocationPct: 50,
    };
    const fakeShape: Shape = {
      name: "fake-straddle",
      validate: () => undefined,
      generateCatalog: () => [fakeSpec, { ...fakeSpec, aaplAllocationPct: 60, xleAllocationPct: 40 }],
      blastRadius: (s) =>
        (s.aaplLongPutStrike - s.aaplShortPutStrike) * (s.aaplAllocationPct / 100),
      evaluate: (strategy): EvaluatedStrategy => ({
        strategy,
        blastRadius: 5,
        metrics: {
          sortino: 1.0,
          winRate: 0.6,
          meanPnl: 200,
          medianPnl: 150,
          probabilityGainAbove20PctAllocated: 0.3,
          probabilityLossAbove50PctAllocated: 0.05,
          hedgeRescueRate: 0.5,
        },
        deepDive: {
          mean: 200, median: 150, p5: -100, p25: 0, p75: 250, p95: 500,
          maxGain: 700, maxLoss: -200,
        },
        maxAcceptableLossBreachProbability: 0.05,
      }),
    };
    registerShape(fakeShape);
    expect(listShapes()).toEqual(expect.arrayContaining(["put-spread-hedge", "fake-straddle"]));

    const result = runScore({
      capital: 50_000,
      maxLossPct: 25,
      seed: 1,
      iterations: 10,
      shapeName: "fake-straddle",
    });
    expect(result.exitCode).toBe(0);
    expect(result.state.shape?.name).toBe("fake-straddle");
  });
});

describe("score: formalize phase validation", () => {
  test("exit 1 on non-positive capital", () => {
    const result = runScore({
      capital: -1,
      maxLossPct: 20,
      seed: 1,
      iterations: 10,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/InvalidScoreInputError/);
  });

  test("exit 1 on max-loss-pct out of (0, 100)", () => {
    const result = runScore({
      capital: 100_000,
      maxLossPct: 0,
      seed: 1,
      iterations: 10,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("max-loss-pct");
  });

  test("exit 1 on non-integer iterations", () => {
    const result = runScore({
      capital: 100_000,
      maxLossPct: 20,
      seed: 1,
      iterations: 0,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("iterations");
  });

  test("InvalidScoreInputError is named", () => {
    const err = new InvalidScoreInputError("seed", -1, "must be non-negative");
    expect(err.name).toBe("InvalidScoreInputError");
  });
});

describe("score: phase transitions", () => {
  test("happy path runs every phase and exits 0 with deterministic output", () => {
    const inputs = {
      capital: 100_000,
      maxLossPct: 20,
      seed: 7,
      iterations: 200,
    };
    const a = runScore(inputs);
    const b = runScore(inputs);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.state.phase).toBe("emit");
    expect(a.state.evaluated?.length).toBeGreaterThan(0);
    expect(a.state.ranked?.length).toBe(a.state.evaluated?.length);
    // Determinism: identical Sortinos for identical seeds.
    expect(a.state.ranked![0].metrics.sortino).toEqual(b.state.ranked![0].metrics.sortino);
  });

  test("ordered catalog is sorted by ascending blast radius", () => {
    const result = runScore({
      capital: 100_000,
      maxLossPct: 20,
      seed: 3,
      iterations: 50,
    });
    const ordered = result.state.ordered!;
    const shape = result.state.shape!;
    for (let i = 1; i < ordered.length; i++) {
      expect(shape.blastRadius(ordered[i])).toBeGreaterThanOrEqual(
        shape.blastRadius(ordered[i - 1]),
      );
    }
  });

  test("execute phase halts early after 3 consecutive low-improvement Sortinos", () => {
    const sortinoSeries = [0.1, 0.102, 0.104, 0.106, 0.4];
    let idx = 0;
    const haltShape: Shape = {
      name: "halt-test",
      validate: () => undefined,
      generateCatalog: () => Array.from({ length: 10 }, (_, i) => ({
        aaplLongPutStrike: 270,
        aaplShortPutStrike: 260,
        hedgeInstrument: "xle-shares" as const,
        aaplAllocationPct: 50,
        xleAllocationPct: 50,
      })),
      blastRadius: (s) =>
        (s.aaplLongPutStrike - s.aaplShortPutStrike) * (s.aaplAllocationPct / 100),
      evaluate: (strategy): EvaluatedStrategy => {
        const sortino = sortinoSeries[Math.min(idx, sortinoSeries.length - 1)];
        idx++;
        return {
          strategy,
          blastRadius: 5,
          metrics: {
            sortino,
            winRate: 0.5,
            meanPnl: 100,
            medianPnl: 80,
            probabilityGainAbove20PctAllocated: 0.1,
            probabilityLossAbove50PctAllocated: 0.1,
            hedgeRescueRate: 0.2,
          },
          deepDive: {
            mean: 100, median: 80, p5: -100, p25: -10, p75: 100, p95: 200,
            maxGain: 250, maxLoss: -150,
          },
          maxAcceptableLossBreachProbability: 0.1,
        };
      },
    };
    registerShape(haltShape);
    const result = runScore({
      capital: 100_000,
      maxLossPct: 20,
      seed: 1,
      iterations: 5,
      shapeName: "halt-test",
    });
    expect(result.exitCode).toBe(0);
    expect(result.state.haltedEarly).toBe(true);
    expect(result.state.evaluated?.length).toBe(4);
  });
});

describe("score: emit-phase judgment", () => {
  test("exit 2 with judgment when no strategy survives the loss filter", () => {
    const lossyShape: Shape = {
      name: "always-lossy",
      validate: () => undefined,
      generateCatalog: () => [
        {
          aaplLongPutStrike: 270,
          aaplShortPutStrike: 260,
          hedgeInstrument: "xle-shares",
          aaplAllocationPct: 50,
          xleAllocationPct: 50,
        },
      ],
      blastRadius: () => 5,
      evaluate: (strategy): EvaluatedStrategy => ({
        strategy,
        blastRadius: 5,
        metrics: {
          sortino: -0.5,
          winRate: 0.1,
          meanPnl: -500,
          medianPnl: -400,
          probabilityGainAbove20PctAllocated: 0,
          probabilityLossAbove50PctAllocated: 0.9,
          hedgeRescueRate: 0,
        },
        deepDive: {
          mean: -500, median: -400, p5: -2000, p25: -1000, p75: 0, p95: 100,
          maxGain: 200, maxLoss: -3000,
        },
        maxAcceptableLossBreachProbability: 0.9,
      }),
    };
    registerShape(lossyShape);
    const result = runScore({
      capital: 50_000,
      maxLossPct: 20,
      seed: 1,
      iterations: 5,
      shapeName: "always-lossy",
    });
    expect(result.exitCode).toBe(2);
    expect(result.judgment?.type).toBe("no-eligible-winner");
    expect(result.output).toContain("COMPOSER_INSTRUCTIONS_BEGIN");
    expect(result.output).toContain("INSTRUMENT_INSTRUCTIONS_BEGIN");
    expect(result.output).toContain("MAX_LOSS_PCT");
  });
});
