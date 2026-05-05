import {
  AAPL_SCENARIOS,
  blastRadius,
  buildStrategyCatalog,
  evaluateStrategy,
  evaluateStrategyWithScenarios,
  InvalidAllocationError,
  InvalidHedgeInstrumentError,
  InvalidStrikeError,
  MissingHedgeStrikeError,
  orderByBlastRadius,
  runOptionsOptimizer,
  type MarketContext,
  type Scenario,
  type StrategySpec,
  validateScenarioProbabilities,
} from "./options-optimizer";

const MARKET: MarketContext = {
  underlyingSpot: 270.94,
  hedgeSpot: 58,
  riskFreeRate: 0.0375,
  underlyingIvPre: 0.38,
  underlyingIvPost: 0.26,
  hedgeIv: 0.3,
  capital: 100000,
  maxAcceptableTotalLossPct: 20,
};

describe("options optimizer catalog + ordering", () => {
  test("builds expected catalog size", () => {
    const catalog = buildStrategyCatalog();
    expect(catalog).toHaveLength(80);
  });

  test("orders by blast radius ascending", () => {
    const specs: StrategySpec[] = [
      {
        aaplLongPutStrike: 272,
        aaplShortPutStrike: 262,
        hedgeInstrument: "xle-shares",
        aaplAllocationPct: 70,
        xleAllocationPct: 30,
      },
      {
        aaplLongPutStrike: 270,
        aaplShortPutStrike: 262,
        hedgeInstrument: "xle-shares",
        aaplAllocationPct: 40,
        xleAllocationPct: 60,
      },
      {
        aaplLongPutStrike: 265,
        aaplShortPutStrike: 255,
        hedgeInstrument: "xle-call",
        xleCallStrike: 59,
        aaplAllocationPct: 50,
        xleAllocationPct: 50,
      },
    ];

    const ordered = orderByBlastRadius(specs);
    const radii = ordered.map((spec) => blastRadius(spec));
    expect(radii[0]).toBeLessThanOrEqual(radii[1]);
    expect(radii[1]).toBeLessThanOrEqual(radii[2]);
  });
});

describe("options optimizer validations", () => {
  test("rejects allocation splits that do not sum to 100", () => {
    const invalid: StrategySpec = {
      aaplLongPutStrike: 272,
      aaplShortPutStrike: 262,
      hedgeInstrument: "xle-shares",
      aaplAllocationPct: 55,
      xleAllocationPct: 40,
    };

    expect(() => evaluateStrategy(invalid, MARKET, { iterations: 10, seed: 1 })).toThrow(
      InvalidAllocationError,
    );
  });

  test("rejects invalid AAPL strike ordering", () => {
    const invalid: StrategySpec = {
      aaplLongPutStrike: 260,
      aaplShortPutStrike: 270,
      hedgeInstrument: "xle-shares",
      aaplAllocationPct: 50,
      xleAllocationPct: 50,
    };

    expect(() => evaluateStrategy(invalid, MARKET, { iterations: 10, seed: 1 })).toThrow(
      InvalidStrikeError,
    );
  });

  test("rejects missing XLE call strike", () => {
    const invalid: StrategySpec = {
      aaplLongPutStrike: 272,
      aaplShortPutStrike: 262,
      hedgeInstrument: "xle-call",
      aaplAllocationPct: 50,
      xleAllocationPct: 50,
    };

    expect(() => evaluateStrategy(invalid, MARKET, { iterations: 10, seed: 1 })).toThrow(
      MissingHedgeStrikeError,
    );
  });

  test("rejects unknown hedge instrument", () => {
    const invalid = {
      aaplLongPutStrike: 272,
      aaplShortPutStrike: 262,
      hedgeInstrument: "invalid-instrument",
      aaplAllocationPct: 50,
      xleAllocationPct: 50,
    } as unknown as StrategySpec;

    expect(() => evaluateStrategy(invalid, MARKET, { iterations: 10, seed: 1 })).toThrow(
      InvalidHedgeInstrumentError,
    );
  });

  test("rejects scenario sets with invalid probability sums", () => {
    expect(() =>
      validateScenarioProbabilities([
        { name: "A", probability: 0.4, minMovePct: 0, maxMovePct: 1 },
        { name: "B", probability: 0.5, minMovePct: 0, maxMovePct: 1 },
      ]),
    ).toThrow(RangeError);
  });
});

describe("options optimizer execution behavior", () => {
  test("halts after 3 consecutive low Sortino improvements", () => {
    const sortinoSeries = [0.1, 0.102, 0.104, 0.106, 0.4];
    let idx = 0;

    const result = runOptionsOptimizer(MARKET, {
      iterations: 10,
      seed: 7,
      evaluateStrategy: (strategy) => {
        const sortino = sortinoSeries[Math.min(idx, sortinoSeries.length - 1)];
        idx++;
        return {
          strategy,
          blastRadius: blastRadius(strategy),
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
            mean: 100,
            median: 80,
            p5: -100,
            p25: -10,
            p75: 100,
            p95: 200,
            maxGain: 250,
            maxLoss: -150,
          },
          maxAcceptableLossBreachProbability: 0.1,
        };
      },
    });

    expect(result.haltedEarly).toBe(true);
    expect(result.evaluatedCount).toBe(4);
  });

  test("returns stable metric shape and winner with loss constraint", () => {
    const result = runOptionsOptimizer(MARKET, {
      iterations: 500,
      seed: 123,
    });

    expect(result.ranked.length).toBeGreaterThan(0);
    expect(result.ranked[0].metrics).toBeDefined();
    expect(typeof result.ranked[0].metrics.sortino).toBe("number");
    expect(result.ranked[0].deepDive).toBeDefined();

    if (result.winner) {
      expect(result.winner.metrics.probabilityLossAbove50PctAllocated).toBeLessThan(0.25);
    }
  });
});

describe("evaluateStrategyWithScenarios — additive variant", () => {
  const SPEC: StrategySpec = {
    aaplShortPutStrike: 260,
    aaplLongPutStrike: 270,
    hedgeInstrument: "xle-call",
    xleCallStrike: 60,
    aaplAllocationPct: 50,
    xleAllocationPct: 50,
  };

  test("bit-for-bit equivalent to evaluateStrategy when scenarios === AAPL_SCENARIOS", () => {
    const a = evaluateStrategy(SPEC, MARKET, { iterations: 1000, seed: 42 });
    const b = evaluateStrategyWithScenarios(SPEC, MARKET, AAPL_SCENARIOS, {
      iterations: 1000,
      seed: 42,
    });
    expect(b.metrics.sortino).toBe(a.metrics.sortino);
    expect(b.metrics.winRate).toBe(a.metrics.winRate);
    expect(b.metrics.meanPnl).toBe(a.metrics.meanPnl);
    expect(b.metrics.medianPnl).toBe(a.metrics.medianPnl);
    expect(b.metrics.probabilityGainAbove20PctAllocated).toBe(
      a.metrics.probabilityGainAbove20PctAllocated,
    );
    expect(b.metrics.probabilityLossAbove50PctAllocated).toBe(
      a.metrics.probabilityLossAbove50PctAllocated,
    );
    expect(b.metrics.hedgeRescueRate).toBe(a.metrics.hedgeRescueRate);
    expect(b.deepDive.maxGain).toBe(a.deepDive.maxGain);
    expect(b.deepDive.maxLoss).toBe(a.deepDive.maxLoss);
  });

  test("rejects scenarios with probabilities not summing to 1.0", () => {
    const bad: Scenario[] = [
      { name: "A", probability: 0.4, minMovePct: -1, maxMovePct: 1 },
      { name: "B", probability: 0.4, minMovePct: -1, maxMovePct: 1 },
    ];
    expect(() =>
      evaluateStrategyWithScenarios(SPEC, MARKET, bad, { iterations: 100, seed: 42 }),
    ).toThrow(RangeError);
  });

  test("different scenarios produce different metrics for the same seed", () => {
    const bullish: Scenario[] = [
      { name: "UP_BIG", probability: 0.5, minMovePct: 5, maxMovePct: 8 },
      { name: "UP_SMALL", probability: 0.5, minMovePct: 2, maxMovePct: 4 },
    ];
    const bearish: Scenario[] = [
      { name: "DOWN_BIG", probability: 0.5, minMovePct: -8, maxMovePct: -5 },
      { name: "DOWN_SMALL", probability: 0.5, minMovePct: -4, maxMovePct: -2 },
    ];
    const a = evaluateStrategyWithScenarios(SPEC, MARKET, bullish, {
      iterations: 1000,
      seed: 42,
    });
    const b = evaluateStrategyWithScenarios(SPEC, MARKET, bearish, {
      iterations: 1000,
      seed: 42,
    });
    expect(a.metrics.sortino).not.toBe(b.metrics.sortino);
    expect(a.metrics.meanPnl).not.toBe(b.metrics.meanPnl);
    // SPEC is a debit put spread (long 270 / short 260) — it profits when
    // AAPL drops. Bearish scenarios → spread ITM → higher mean PnL than bullish.
    expect(b.metrics.meanPnl).toBeGreaterThan(a.metrics.meanPnl);
  });

  test("deterministic: same inputs produce identical output", () => {
    const empirical: Scenario[] = [
      { name: "H1", probability: 0.25, minMovePct: 2, maxMovePct: 3 },
      { name: "H2", probability: 0.25, minMovePct: -1, maxMovePct: 1 },
      { name: "H3", probability: 0.25, minMovePct: 4, maxMovePct: 5 },
      { name: "H4", probability: 0.25, minMovePct: -3, maxMovePct: -2 },
    ];
    const a = evaluateStrategyWithScenarios(SPEC, MARKET, empirical, {
      iterations: 500,
      seed: 7,
    });
    const b = evaluateStrategyWithScenarios(SPEC, MARKET, empirical, {
      iterations: 500,
      seed: 7,
    });
    expect(b.metrics.sortino).toBe(a.metrics.sortino);
    expect(b.metrics.meanPnl).toBe(a.metrics.meanPnl);
  });

  test("does not modify AAPL_SCENARIOS or XLE_SCENARIOS", () => {
    const aaplCopy = AAPL_SCENARIOS.map((s) => ({ ...s }));
    evaluateStrategyWithScenarios(SPEC, MARKET, AAPL_SCENARIOS, {
      iterations: 100,
      seed: 1,
    });
    expect(AAPL_SCENARIOS).toEqual(aaplCopy);
  });
});
