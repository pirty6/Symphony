import {
  buildSectorCorrelationMatrix,
  buildHybridCorrelationMatrix,
  averagePairwiseCorrelation,
  pearsonCorrelation,
  subsetCorrelationSource,
} from "./correlation";

describe("pearsonCorrelation", () => {
  test("identity series correlates 1.0 with itself", () => {
    const a = [0.01, -0.02, 0.015, 0.005, -0.01];
    expect(pearsonCorrelation(a, a)).toBeCloseTo(1, 9);
  });

  test("perfect anti-correlation = -1.0", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [5, 4, 3, 2, 1];
    expect(pearsonCorrelation(a, b)).toBeCloseTo(-1, 9);
  });

  test("known textbook input (independence ≈ 0)", () => {
    // x and y orthogonal in deviation space.
    const x = [-2, -1, 0, 1, 2];
    const y = [4, 1, 0, 1, 4];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(0, 9);
  });

  test("zero-variance series → 0 (no linear relationship)", () => {
    expect(pearsonCorrelation([1, 1, 1, 1], [2, 3, 4, 5])).toBe(0);
  });

  test("length mismatch throws", () => {
    expect(() => pearsonCorrelation([1, 2], [1, 2, 3])).toThrow(RangeError);
  });
});

describe("buildHybridCorrelationMatrix", () => {
  const series20 = (offset: number) =>
    Array.from({ length: 22 }, (_, i) => 0.001 * (i + offset) - 0.01);

  test("realized path when both sides have ≥20 returns", () => {
    const a = series20(0);
    const b = series20(0); // identical → corr 1
    const c = a.map((v) => -v); // anti-correlated → corr -1
    const { matrix, sources } = buildHybridCorrelationMatrix([
      { ticker: "A", sector: "x", dailyReturns: a },
      { ticker: "B", sector: "y", dailyReturns: b },
      { ticker: "C", sector: "z", dailyReturns: c },
    ]);
    expect(matrix[0][1]).toBeCloseTo(1, 9);
    expect(matrix[0][2]).toBeCloseTo(-1, 9);
    expect(sources[0][1]).toBe("realized");
    expect(sources[0][2]).toBe("realized");
  });

  test("falls back to sector when one side missing returns", () => {
    const a = series20(0);
    const { matrix, sources } = buildHybridCorrelationMatrix([
      { ticker: "A", sector: "tech", dailyReturns: a },
      { ticker: "B", sector: "tech" }, // no returns
      { ticker: "C", sector: "energy" }, // no returns
    ]);
    expect(matrix[0][1]).toBe(1); // same sector fallback
    expect(matrix[0][2]).toBe(0); // diff sector fallback
    expect(sources[0][1]).toBe("sector-fallback");
    expect(sources[0][2]).toBe("sector-fallback");
  });

  test("falls back when one side has < 20 entries", () => {
    const a = series20(0);
    const tooShort = a.slice(0, 10);
    const { sources } = buildHybridCorrelationMatrix([
      { ticker: "A", sector: "tech", dailyReturns: a },
      { ticker: "B", sector: "tech", dailyReturns: tooShort },
    ]);
    expect(sources[0][1]).toBe("sector-fallback");
  });

  test("aligns trailing overlap when lengths differ but both ≥20", () => {
    const longSeries = Array.from({ length: 30 }, (_, i) => i * 0.001);
    const shortSeries = longSeries.slice(8); // last 22 entries
    const { matrix, sources } = buildHybridCorrelationMatrix([
      { ticker: "A", sector: "x", dailyReturns: longSeries },
      { ticker: "B", sector: "y", dailyReturns: shortSeries },
    ]);
    expect(matrix[0][1]).toBeCloseTo(1, 9); // identical trailing window
    expect(sources[0][1]).toBe("realized");
  });

  test("diagonal is always 1.0 with source 'realized'", () => {
    const { matrix, sources } = buildHybridCorrelationMatrix([
      { ticker: "A", sector: "x" },
      { ticker: "B", sector: "y" },
    ]);
    expect(matrix[0][0]).toBe(1);
    expect(matrix[1][1]).toBe(1);
    expect(sources[0][0]).toBe("realized");
  });
});

describe("subsetCorrelationSource", () => {
  test("singleton reports realized", () => {
    const sources = [["realized"]] as const;
    expect(subsetCorrelationSource(sources as never, [0])).toBe("realized");
  });

  test("all-realized off-diagonal → realized", () => {
    const s = [
      ["realized", "realized"],
      ["realized", "realized"],
    ] as const;
    expect(subsetCorrelationSource(s as never, [0, 1])).toBe("realized");
  });

  test("all-fallback off-diagonal → sector-fallback", () => {
    const s = [
      ["realized", "sector-fallback"],
      ["sector-fallback", "realized"],
    ] as const;
    expect(subsetCorrelationSource(s as never, [0, 1])).toBe("sector-fallback");
  });

  test("mixed off-diagonal → mixed", () => {
    const s = [
      ["realized", "realized", "sector-fallback"],
      ["realized", "realized", "realized"],
      ["sector-fallback", "realized", "realized"],
    ] as const;
    expect(subsetCorrelationSource(s as never, [0, 1, 2])).toBe("mixed");
  });
});

describe("integration: hybrid matrix + averagePairwiseCorrelation", () => {
  test("legacy sector matrix still works for backward compat", () => {
    const matrix = buildSectorCorrelationMatrix([
      { ticker: "A", sector: "x" },
      { ticker: "B", sector: "x" },
    ]);
    expect(averagePairwiseCorrelation(matrix, [0, 1])).toBe(1);
  });
});
