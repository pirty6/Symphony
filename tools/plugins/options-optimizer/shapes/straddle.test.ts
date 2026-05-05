/**
 * straddle.test.ts — score-level tests for the straddle shape.
 *
 * These tests do NOT touch score.ts, cli.ts, registry.ts, or shapes/types.ts.
 * They prove the Shape contract is genuinely pluggable by exercising the
 * straddle through its public Shape surface and through runScore.
 */

import { runScore } from "../score";
import {
  clearShapeRegistry,
  hasShape,
  listShapes,
  registerShape,
} from "./registry";
import { putSpreadHedgeShape } from "./put-spread-hedge";
import {
  generateStraddleCatalog,
  NegativeStrikeError,
  NonPositiveContractsError,
  InvalidStraddleSpecError,
  straddleBlastRadius,
  straddleEntryPremium,
  straddleShape,
  type StraddleSpec,
} from "./straddle";
import type { MarketContext, StrategySpec } from "../options-optimizer";

const MARKET: MarketContext = {
  underlyingSpot: 270.94,
  hedgeSpot: 58,
  riskFreeRate: 0.0375,
  underlyingIvPre: 0.38,
  underlyingIvPost: 0.26,
  hedgeIv: 0.3,
  capital: 100_000,
  maxAcceptableTotalLossPct: 20,
};

function freshRegistryWithStraddle(): void {
  clearShapeRegistry();
  registerShape(putSpreadHedgeShape);
  registerShape(straddleShape);
}

beforeEach(() => {
  freshRegistryWithStraddle();
});

describe("straddle: registration", () => {
  test("self-registers via shapes/index.ts side-effect import", () => {
    // Use isolated modules so the registry singleton and index module
    // are both fresh — proving the registration is driven by the
    // shapes/index.ts import side-effect, not by manual registration.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const reg = require("./registry");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./index");
      expect(reg.hasShape("straddle")).toBe(true);
      expect(reg.hasShape("put-spread-hedge")).toBe(true);
    });
  });

  test("straddleShape exposes the Shape contract", () => {
    expect(straddleShape.name).toBe("straddle");
    expect(typeof straddleShape.validate).toBe("function");
    expect(typeof straddleShape.generateCatalog).toBe("function");
    expect(typeof straddleShape.blastRadius).toBe("function");
    expect(typeof straddleShape.evaluate).toBe("function");
  });
});

describe("straddle: validate", () => {
  function baseSpec(overrides: Partial<StraddleSpec> = {}): StraddleSpec {
    return {
      aaplLongPutStrike: 271,
      aaplShortPutStrike: 271,
      hedgeInstrument: "xle-shares",
      aaplAllocationPct: 100,
      xleAllocationPct: 0,
      __shape: "straddle",
      callStrike: 271,
      putStrike: 271,
      contracts: 1,
      ...overrides,
    };
  }

  test("accepts a well-formed straddle spec", () => {
    expect(() => straddleShape.validate(baseSpec())).not.toThrow();
  });

  test("rejects negative call strike with NegativeStrikeError", () => {
    expect(() => straddleShape.validate(baseSpec({ callStrike: -1 }))).toThrow(
      NegativeStrikeError,
    );
  });

  test("rejects zero call strike with NegativeStrikeError", () => {
    expect(() => straddleShape.validate(baseSpec({ callStrike: 0 }))).toThrow(
      NegativeStrikeError,
    );
  });

  test("rejects negative put strike with NegativeStrikeError", () => {
    expect(() => straddleShape.validate(baseSpec({ putStrike: -50 }))).toThrow(
      NegativeStrikeError,
    );
  });

  test("rejects zero contracts with NonPositiveContractsError", () => {
    expect(() => straddleShape.validate(baseSpec({ contracts: 0 }))).toThrow(
      NonPositiveContractsError,
    );
  });

  test("rejects negative contracts with NonPositiveContractsError", () => {
    expect(() => straddleShape.validate(baseSpec({ contracts: -3 }))).toThrow(
      NonPositiveContractsError,
    );
  });

  test("rejects non-straddle spec with InvalidStraddleSpecError", () => {
    const notStraddle: StrategySpec = {
      aaplLongPutStrike: 270,
      aaplShortPutStrike: 260,
      hedgeInstrument: "xle-shares",
      aaplAllocationPct: 50,
      xleAllocationPct: 50,
    };
    expect(() => straddleShape.validate(notStraddle)).toThrow(
      InvalidStraddleSpecError,
    );
  });
});

describe("straddle: catalog", () => {
  test("generateCatalog produces a deterministic, non-empty list", () => {
    const a = straddleShape.generateCatalog();
    const b = straddleShape.generateCatalog();
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("catalog sweeps ATM ± offsets × contract sizes", () => {
    const catalog = generateStraddleCatalog();
    const strikes = new Set(catalog.map((s) => s.callStrike));
    const contracts = new Set(catalog.map((s) => s.contracts));
    expect(strikes.size).toBeGreaterThanOrEqual(3);
    expect(contracts.size).toBeGreaterThanOrEqual(3);
    expect(strikes).toEqual(new Set([269, 271, 273]));
    // call strike == put strike for a true ATM straddle
    for (const spec of catalog) {
      expect(spec.callStrike).toBe(spec.putStrike);
    }
  });

  test("every catalog spec passes validate", () => {
    for (const spec of straddleShape.generateCatalog()) {
      expect(() => straddleShape.validate(spec)).not.toThrow();
    }
  });
});

describe("straddle: blast radius", () => {
  test("context-aware blastRadius = total_entry_premium / capital", () => {
    const [spec] = generateStraddleCatalog();
    const premium = straddleEntryPremium(spec, MARKET);
    const br = straddleBlastRadius(spec, MARKET);
    expect(br).toBeCloseTo(premium / MARKET.capital, 12);
    expect(br).toBeGreaterThan(0);
  });

  test("contextual blastRadius is monotonic in contracts", () => {
    const catalog = generateStraddleCatalog();
    const sameStrike = catalog.filter((s) => s.callStrike === 271);
    const sorted = [...sameStrike].sort((a, b) => a.contracts - b.contracts);
    let prev = -Infinity;
    for (const spec of sorted) {
      const br = straddleBlastRadius(spec, MARKET);
      expect(br).toBeGreaterThan(prev);
      prev = br;
    }
  });
});

describe("straddle: evaluate determinism", () => {
  test("identical (seed, iterations, spec, context) yields identical output", () => {
    const [spec] = generateStraddleCatalog();
    const a = straddleShape.evaluate(spec, MARKET, { iterations: 500, seed: 7 });
    const b = straddleShape.evaluate(spec, MARKET, { iterations: 500, seed: 7 });
    expect(a.metrics).toEqual(b.metrics);
    expect(a.deepDive).toEqual(b.deepDive);
  });

  test("different seeds yield different metric distributions", () => {
    const [spec] = generateStraddleCatalog();
    const a = straddleShape.evaluate(spec, MARKET, { iterations: 500, seed: 7 });
    const b = straddleShape.evaluate(spec, MARKET, { iterations: 500, seed: 8 });
    expect(a.metrics.meanPnl).not.toBe(b.metrics.meanPnl);
  });
});

describe("straddle: evaluate behavior", () => {
  test("INLINE-only context (zero move + IV crush) produces a loss", () => {
    // Build a degenerate context where AAPL_SCENARIOS still drives moves
    // but post-earnings IV is well below pre-earnings IV. Real INLINE
    // has tiny moves; with crush, both legs lose value → mean P&L < 0.
    const flatContext: MarketContext = {
      ...MARKET,
      underlyingIvPre: 0.50,
      underlyingIvPost: 0.10,
    };
    const [spec] = generateStraddleCatalog();
    const result = straddleShape.evaluate(spec, flatContext, {
      iterations: 4000,
      seed: 11,
    });
    // With heavy IV crush and AAPL's mostly-modest move distribution,
    // the deep-dive median should reflect a loss for INLINE-style cases.
    expect(result.deepDive.p25).toBeLessThan(0);
  });

  test("evaluate uses AAPL_SCENARIOS — both gains and losses appear", () => {
    const [spec] = generateStraddleCatalog();
    const result = straddleShape.evaluate(spec, MARKET, {
      iterations: 4000,
      seed: 13,
    });
    expect(result.deepDive.maxGain).toBeGreaterThan(0);
    expect(result.deepDive.maxLoss).toBeLessThan(0);
    expect(result.metrics.winRate).toBeGreaterThan(0);
    expect(result.metrics.winRate).toBeLessThan(1);
  });

  test("evaluate handles premium > capital gracefully (filtered)", () => {
    const tinyContext: MarketContext = { ...MARKET, capital: 10 };
    const [spec] = generateStraddleCatalog();
    const result = straddleShape.evaluate(spec, tinyContext, {
      iterations: 100,
      seed: 1,
    });
    expect(result.metrics.probabilityLossAbove50PctAllocated).toBe(1);
    expect(result.maxAcceptableLossBreachProbability).toBe(1);
  });
});

describe("straddle: pluggable through runScore", () => {
  test("runScore --shape straddle exits 0 with a ranked result", () => {
    const result = runScore({
      capital: 100_000,
      maxLossPct: 20,
      seed: 42,
      iterations: 500,
      shapeName: "straddle",
    });
    expect(result.exitCode).toBe(0);
    expect(result.state.ranked?.length).toBeGreaterThan(0);
    expect(result.output).toContain("shape=straddle");
  });

  test("runScore --shape straddle on tiny capital still completes (no crash)", () => {
    const result = runScore({
      capital: 5_000,
      maxLossPct: 20,
      seed: 42,
      iterations: 200,
      shapeName: "straddle",
    });
    // Either winner found (exit 0) or judgment "no-eligible-winner" (exit 2).
    // Both are non-fatal — the contract is "no crash, named exit".
    expect([0, 2]).toContain(result.exitCode);
  });
});
