import * as fs from "node:fs";
import * as path from "node:path";
import {
  runScreener,
  registerFilter,
  registerDistribution,
  clearFilterRegistry,
  clearDistributionRegistry,
  binaryEventWindowFilter,
  ivRankFilter,
  liquidityFilter,
  priceRangeFilter,
  EARNINGS_DISTRIBUTION,
  DuplicateFilterError,
  DuplicateDistributionError,
  InvalidWatchlistError,
  UnimplementedDistributionError,
  maybeBuildEmpiricalDistribution,
  type RawCandidate,
  type ScreenerInputs,
  type CandidateFilter,
} from "./score";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "example-watchlist.json");

function loadFixture(): RawCandidate[] {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as RawCandidate[];
}

function defaultInputs(overrides: Partial<ScreenerInputs> = {}): ScreenerInputs {
  return {
    watchlist: loadFixture(),
    weekOf: "2026-04-27",
    seed: 42,
    minIvRank: 50,
    priceMin: 20,
    priceMax: 500,
    sectorCap: 1,
    eventWindowDays: 7,
    ...overrides,
  };
}

describe("screener: filter registry", () => {
  test("default filters register on first run", () => {
    const result = runScreener(defaultInputs());
    expect(result.exitCode).toBe(0);
  });

  test("duplicate filter registration throws", () => {
    runScreener(defaultInputs()); // ensure defaults are registered
    expect(() => registerFilter(binaryEventWindowFilter)).toThrow(DuplicateFilterError);
  });

  test("custom filter is honored", () => {
    clearFilterRegistry();
    const tickerOnly: CandidateFilter = {
      name: "ticker-aapl-only",
      apply: (c) => c.ticker === "AAPL",
      reason: () => "not AAPL",
    };
    registerFilter(tickerOnly);
    const result = runScreener(defaultInputs());
    expect(result.candidates.map((c) => c.ticker)).toEqual(["AAPL"]);
    clearFilterRegistry();
  });
});

describe("screener: distribution registry", () => {
  test("duplicate distribution throws", () => {
    runScreener(defaultInputs()); // ensure defaults registered
    expect(() => registerDistribution(EARNINGS_DISTRIBUTION)).toThrow(
      DuplicateDistributionError,
    );
  });

  test("FDA_BINARY candidate skipped with unimplemented warning", () => {
    const result = runScreener(defaultInputs());
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("unimplemented distribution kinds: FDA_BINARY");
    expect(result.candidates.find((c) => c.ticker === "BIIB")).toBeUndefined();
  });

  test("registering FDA_BINARY clears the warning", () => {
    clearDistributionRegistry();
    // Re-register defaults manually
    registerDistribution(EARNINGS_DISTRIBUTION);
    registerDistribution({
      kind: "FDA_BINARY",
      buckets: [
        { name: "APPROVAL", probability: 0.65, minMovePct: 20, maxMovePct: 60 },
        { name: "REJECTION", probability: 0.35, minMovePct: -80, maxMovePct: -40 },
      ],
    });
    const result = runScreener(defaultInputs({ minIvRank: 50, sectorCap: 99 }));
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("unimplemented");
    expect(result.candidates.find((c) => c.ticker === "BIIB")).toBeDefined();
    clearDistributionRegistry();
    registerDistribution(EARNINGS_DISTRIBUTION);
  });

  test("invalid probability sum rejected", () => {
    clearDistributionRegistry();
    expect(() =>
      registerDistribution({
        kind: "MACRO_SENSITIVE",
        buckets: [
          { name: "A", probability: 0.4, minMovePct: 0, maxMovePct: 1 },
          { name: "B", probability: 0.4, minMovePct: 0, maxMovePct: 1 },
        ],
      }),
    ).toThrow(RangeError);
    registerDistribution(EARNINGS_DISTRIBUTION);
  });
});

describe("screener: validation", () => {
  test("rejects empty watchlist", () => {
    const result = runScreener(defaultInputs({ watchlist: [] }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("InvalidWatchlistError");
  });

  test("rejects malformed candidate", () => {
    const bad = loadFixture();
    (bad[0] as unknown as Record<string, unknown>).spot = -1;
    const result = runScreener(defaultInputs({ watchlist: bad }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("InvalidWatchlistError");
  });

  test("rejects invalid week-of", () => {
    const result = runScreener(defaultInputs({ weekOf: "not-a-date" }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("InvalidScreenerInputError");
  });

  test("rejects negative seed", () => {
    const result = runScreener(defaultInputs({ seed: -1 }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("InvalidScreenerInputError");
  });
});

describe("screener: filtering behavior", () => {
  test("low IV rank candidates filtered out", () => {
    const result = runScreener(defaultInputs({ minIvRank: 60, sectorCap: 99 }));
    expect(result.candidates.find((c) => c.ticker === "MSFT")).toBeUndefined(); // 55 IV
  });

  test("price-range filter excludes low-priced names", () => {
    const result = runScreener(defaultInputs({ priceMin: 50, sectorCap: 99 }));
    expect(result.candidates.find((c) => c.ticker === "F")).toBeUndefined(); // $12.85
    expect(result.candidates.find((c) => c.ticker === "PFE")).toBeUndefined(); // $28.45
  });

  test("sector cap = 1 keeps only top IV per sector", () => {
    const result = runScreener(defaultInputs({ sectorCap: 1 }));
    const techCount = result.candidates.filter((c) => c.sector === "tech-megacap").length;
    expect(techCount).toBe(1);
    // META at 70 IV should win the tech-megacap slot
    const tech = result.candidates.find((c) => c.sector === "tech-megacap");
    expect(tech?.ticker).toBe("META");
  });

  test("event window filter excludes far-out catalysts", () => {
    const result = runScreener(defaultInputs({ eventWindowDays: 1, sectorCap: 99 }));
    // weekOf 2026-04-27, eventWindowDays 1 → only catalysts on 04-27 or 04-28 pass.
    expect(result.candidates.length).toBe(0);
    expect(result.exitCode).toBe(2);
  });
});

describe("screener: deterministic emission", () => {
  test("identical inputs produce identical candidate ordering", () => {
    const a = runScreener(defaultInputs());
    const b = runScreener(defaultInputs());
    expect(a.candidates.map((c) => c.ticker)).toEqual(b.candidates.map((c) => c.ticker));
    expect(a.output).toBe(b.output);
  });

  test("output contains JSON block parseable as ScreenedCandidate[]", () => {
    const result = runScreener(defaultInputs());
    expect(result.exitCode).toBe(0);
    const begin = result.output.indexOf("CANDIDATES_JSON_BEGIN\n") + "CANDIDATES_JSON_BEGIN\n".length;
    const end = result.output.indexOf("\nCANDIDATES_JSON_END");
    const json = result.output.substring(begin, end);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(result.candidates.length);
    expect(parsed[0].scenarioDistribution.kind).toBeDefined();
  });
});

describe("screener: judgment emission", () => {
  test("no-candidates emits exit 2 with paired blocks", () => {
    const result = runScreener(defaultInputs({ minIvRank: 99, sectorCap: 99 }));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("JUDGMENT_REQUEST: no-candidates");
    expect(result.output).toContain("COMPOSER_INSTRUCTIONS_BEGIN");
    expect(result.output).toContain("INSTRUMENT_INSTRUCTIONS_BEGIN");
    expect(result.output).toContain("ALLOWED TOOLS:");
  });
});

describe("screener: built-in filters individually", () => {
  test("binaryEventWindowFilter respects eventWindowDays", () => {
    const inputs = defaultInputs({ eventWindowDays: 1 });
    const aapl = inputs.watchlist.find((c) => c.ticker === "AAPL")!;
    expect(binaryEventWindowFilter.apply(aapl, inputs)).toBe(false);
    const wide = { ...inputs, eventWindowDays: 7 };
    expect(binaryEventWindowFilter.apply(aapl, wide)).toBe(true);
  });

  test("ivRankFilter compares to threshold", () => {
    const inputs = defaultInputs();
    const xom = inputs.watchlist.find((c) => c.ticker === "XOM")!; // 48
    expect(ivRankFilter.apply(xom, inputs)).toBe(false);
    expect(ivRankFilter.apply(xom, { ...inputs, minIvRank: 40 })).toBe(true);
  });

  test("liquidityFilter rejects open interest <= 1000", () => {
    const inputs = defaultInputs();
    const stub: RawCandidate = {
      ticker: "X",
      sector: "test",
      spot: 100,
      ivRank: 99,
      openInterest: 500,
      catalyst: { kind: "EARNINGS", description: "x", date: "2026-04-28" },
    };
    expect(liquidityFilter.apply(stub, inputs)).toBe(false);
  });

  test("priceRangeFilter respects bounds", () => {
    const inputs = defaultInputs();
    const meta = inputs.watchlist.find((c) => c.ticker === "META")!; // $488
    expect(priceRangeFilter.apply(meta, inputs)).toBe(true);
    expect(priceRangeFilter.apply(meta, { ...inputs, priceMax: 400 })).toBe(false);
  });
});

describe("screener: ivPre + historicalMoves wiring", () => {
  test("validation rejects out-of-range ivPre", () => {
    const bad = loadFixture();
    bad[0].ivPre = 7;
    const result = runScreener(defaultInputs({ watchlist: bad }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("InvalidWatchlistError");
  });

  test("validation rejects malformed historicalMoves", () => {
    const bad = loadFixture();
    bad[0].historicalMoves = [1, 2, "oops" as unknown as number];
    const result = runScreener(defaultInputs({ watchlist: bad }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("InvalidWatchlistError");
  });

  test("validation rejects historicalMoves > 32 entries", () => {
    const bad = loadFixture();
    bad[0].historicalMoves = Array(33).fill(1);
    const result = runScreener(defaultInputs({ watchlist: bad }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("InvalidWatchlistError");
  });

  test("ivPre passes through to ScreenedCandidate", () => {
    const result = runScreener(defaultInputs({ sectorCap: 99 }));
    const aapl = result.candidates.find((c) => c.ticker === "AAPL");
    expect(aapl?.ivPre).toBe(0.38);
  });

  test("validation rejects unknown ivRankSource", () => {
    const bad = loadFixture();
    bad[0].ivRankSource = "guess" as unknown as "hv-proxy";
    const result = runScreener(defaultInputs({ watchlist: bad }));
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("InvalidWatchlistError");
  });

  test("ivRankSource passes through to ScreenedCandidate when provided", () => {
    const wl = loadFixture();
    wl[0].ivRankSource = "hv-proxy";
    const result = runScreener(defaultInputs({ watchlist: wl, sectorCap: 99 }));
    const aapl = result.candidates.find((c) => c.ticker === wl[0].ticker);
    expect(aapl?.ivRankSource).toBe("hv-proxy");
  });

  test("ivRankSource accepts both 'hv-proxy' and 'iv-history'", () => {
    const wl = loadFixture();
    wl[0].ivRankSource = "iv-history";
    const result = runScreener(defaultInputs({ watchlist: wl, sectorCap: 99 }));
    expect(result.exitCode).toBe(0);
    const aapl = result.candidates.find((c) => c.ticker === wl[0].ticker);
    expect(aapl?.ivRankSource).toBe("iv-history");
  });

  test("maybeBuildEmpiricalDistribution returns null for < 4 moves", () => {
    const candidate: RawCandidate = {
      ticker: "X",
      sector: "test",
      spot: 100,
      ivRank: 50,
      openInterest: 5000,
      catalyst: { kind: "EARNINGS", description: "e", date: "2026-04-30" },
      historicalMoves: [1, 2, 3],
    };
    expect(maybeBuildEmpiricalDistribution(candidate)).toBeNull();
  });

  test("maybeBuildEmpiricalDistribution returns null for non-EARNINGS", () => {
    const candidate: RawCandidate = {
      ticker: "X",
      sector: "test",
      spot: 100,
      ivRank: 50,
      openInterest: 5000,
      catalyst: { kind: "FDA_BINARY", description: "e", date: "2026-04-30" },
      historicalMoves: [1, 2, 3, 4, 5],
    };
    expect(maybeBuildEmpiricalDistribution(candidate)).toBeNull();
  });

  test("maybeBuildEmpiricalDistribution sums to 1.0 for 8 moves", () => {
    const candidate: RawCandidate = {
      ticker: "ZZZ",
      sector: "test",
      spot: 100,
      ivRank: 50,
      openInterest: 5000,
      catalyst: { kind: "EARNINGS", description: "e", date: "2026-04-30" },
      historicalMoves: [4.5, -2.1, 6.8, -7.3, 1.2, 3.4, -1.5, 5.0],
    };
    const dist = maybeBuildEmpiricalDistribution(candidate);
    expect(dist).not.toBeNull();
    expect(dist!.kind).toBe("EARNINGS");
    expect(dist!.buckets.length).toBe(8);
    const total = dist!.buckets.reduce((a, b) => a + b.probability, 0);
    expect(total).toBeCloseTo(1.0, 9);
    // Bucket name carries ticker prefix so portfolio-runner can detect it.
    expect(dist!.buckets[0].name.startsWith("ZZZ_HIST_")).toBe(true);
  });

  test("maybeBuildEmpiricalDistribution scales bucket band with sample stdev (±σ/4)", () => {
    const moves = [4.5, -2.1, 6.8, -7.3, 1.2, 3.4, -1.5, 5.0];
    const candidate: RawCandidate = {
      ticker: "ZZZ",
      sector: "test",
      spot: 100,
      ivRank: 50,
      openInterest: 5000,
      catalyst: { kind: "EARNINGS", description: "e", date: "2026-04-30" },
      historicalMoves: moves,
    };
    const dist = maybeBuildEmpiricalDistribution(candidate)!;
    const N = moves.length;
    const mean = moves.reduce((a, b) => a + b, 0) / N;
    const variance =
      moves.reduce((acc, m) => acc + (m - mean) * (m - mean), 0) / (N - 1);
    const expectedHalfBand = Math.max(Math.sqrt(variance) / 4, 0.25);
    const band0 = (dist.buckets[0].maxMovePct - dist.buckets[0].minMovePct) / 2;
    expect(band0).toBeCloseTo(expectedHalfBand, 9);
    // Center remains the observation itself.
    expect((dist.buckets[0].minMovePct + dist.buckets[0].maxMovePct) / 2).toBeCloseTo(
      moves[0],
      9,
    );
  });

  test("maybeBuildEmpiricalDistribution applies ±0.25% floor for very low-σ samples", () => {
    const candidate: RawCandidate = {
      ticker: "FLAT",
      sector: "test",
      spot: 100,
      ivRank: 50,
      openInterest: 5000,
      catalyst: { kind: "EARNINGS", description: "e", date: "2026-04-30" },
      historicalMoves: [1.0, 1.01, 0.99, 1.0],
    };
    const dist = maybeBuildEmpiricalDistribution(candidate)!;
    const halfBand = (dist.buckets[0].maxMovePct - dist.buckets[0].minMovePct) / 2;
    expect(halfBand).toBeCloseTo(0.25, 9);
  });

  test("registerDistribution accepts the empirical output", () => {
    const candidate: RawCandidate = {
      ticker: "ZZZ",
      sector: "test",
      spot: 100,
      ivRank: 50,
      openInterest: 5000,
      catalyst: { kind: "EARNINGS", description: "e", date: "2026-04-30" },
      historicalMoves: [1, 2, 3, 4, 5, 6, 7, 8],
    };
    const dist = maybeBuildEmpiricalDistribution(candidate)!;
    // Should not throw RangeError (probabilities sum to 1.0)
    expect(() => {
      // Use a fresh registry to avoid colliding with EARNINGS default.
      clearDistributionRegistry();
      registerDistribution(dist);
      clearDistributionRegistry();
      registerDistribution(EARNINGS_DISTRIBUTION);
    }).not.toThrow();
  });

  test("end-to-end: candidate with historicalMoves gets per-ticker distribution", () => {
    const result = runScreener(defaultInputs({ sectorCap: 99 }));
    expect(result.exitCode).toBe(0);
    const aapl = result.candidates.find((c) => c.ticker === "AAPL");
    expect(aapl).toBeDefined();
    expect(aapl!.scenarioDistribution.buckets[0].name.startsWith("AAPL_HIST_")).toBe(true);
    expect(result.output).toContain("Per-ticker empirical distributions");
  });

  test("end-to-end: candidate without historicalMoves gets registry default", () => {
    const result = runScreener(defaultInputs({ sectorCap: 99 }));
    const meta = result.candidates.find((c) => c.ticker === "META");
    expect(meta).toBeDefined();
    expect(meta!.scenarioDistribution.buckets[0].name).toBe("CLEAN_BEAT");
  });
});
