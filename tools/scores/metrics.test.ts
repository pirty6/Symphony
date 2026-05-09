import * as fs from "node:fs";
import * as path from "node:path";
import {
  compareToBaseline,
  latestRunFile,
  loadSavedRun,
  runMetrics,
  type RunMetrics,
} from "./metrics";
import type { ExecutableScore, PerformedBeat, PerformedVoice, SavedRun } from "../symphony/types";
import type { PatternScore } from "../patterns/types";

const STUB_PATTERN_SCORE: PatternScore = {
  pattern: "test",
  domain: "test",
  beats: [],
};

const STUB_EXECUTABLE_SCORE: ExecutableScore = {
  schemaVersion: 1,
  id: "stub",
  frequencyMap: { key: "test", activeLevels: [] },
  beats: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
  generatedFrom: {
    rawHash: "stub",
    canonicalHash: "stub",
    schemaVersion: 1,
  },
};

function makeVoice(confidence: number): PerformedVoice {
  return {
    instrument: "analyze",
    output: "x",
    confidence,
    producedBy: "maestro-assessor",
  };
}

function makeBeat(beatIndex: number, voices: readonly PerformedVoice[]): PerformedBeat {
  return {
    beatIndex,
    voices,
    verdict: undefined,
    stateHash: "h",
  };
}

function makeRun(
  beats: readonly PerformedBeat[],
  startedAt: string | undefined,
  completedAt: string | undefined,
): SavedRun {
  return {
    schemaVersion: 1,
    patternScore: STUB_PATTERN_SCORE,
    executableScore: STUB_EXECUTABLE_SCORE,
    performance: {
      scoreId: "s",
      beats,
      startedAt: (startedAt ?? "") as string,
      completedAt: completedAt as string | undefined,
      outcome: "success",
    },
    problemFingerprint: "fp",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

describe("runMetrics", () => {
  it("counts beats", () => {
    const run = makeRun(
      [makeBeat(0, [makeVoice(0.8)]), makeBeat(1, [makeVoice(0.6)])],
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
    );
    expect(runMetrics(run).beatCount).toBe(2);
  });

  it("counts spawns across all voices", () => {
    const run = makeRun(
      [makeBeat(0, [makeVoice(0.8), makeVoice(0.6)]), makeBeat(1, [makeVoice(1.0)])],
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
    );
    expect(runMetrics(run).spawnCount).toBe(3);
  });

  it("computes wallMs from startedAt/completedAt", () => {
    const run = makeRun(
      [makeBeat(0, [makeVoice(1)])],
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.500Z",
    );
    expect(runMetrics(run).wallMs).toBe(1500);
  });

  it("returns wallMs undefined when completedAt missing", () => {
    const run = makeRun([makeBeat(0, [makeVoice(1)])], "2026-01-01T00:00:00.000Z", undefined);
    expect(runMetrics(run).wallMs).toBeUndefined();
  });

  it("computes meanConfidence as flat mean across voices", () => {
    const run = makeRun(
      [makeBeat(0, [makeVoice(0.8), makeVoice(0.6)]), makeBeat(1, [makeVoice(1.0)])],
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
    );
    expect(runMetrics(run).meanConfidence).toBeCloseTo(0.8, 10);
  });

  it("returns meanConfidence 0 when no voices", () => {
    const run = makeRun([makeBeat(0, [])], "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z");
    expect(runMetrics(run).meanConfidence).toBe(0);
  });
});

describe("compareToBaseline", () => {
  const base: RunMetrics = {
    beatCount: 6,
    spawnCount: 6,
    wallMs: 200_000,
    meanConfidence: 0.9,
  };

  it("passes when all gates met", () => {
    const cmp = compareToBaseline({ ...base }, base);
    expect(cmp.ok).toBe(true);
    expect(cmp.failures).toEqual([]);
  });

  it("fails on missing beats", () => {
    const cmp = compareToBaseline({ ...base, beatCount: 5 }, base);
    expect(cmp.ok).toBe(false);
    expect(cmp.failures).toHaveLength(1);
    expect(cmp.failures[0]).toMatch(/beatCount/);
  });

  it("fails on skipped voices", () => {
    const cmp = compareToBaseline({ ...base, spawnCount: 5 }, base);
    expect(cmp.ok).toBe(false);
    expect(cmp.failures).toHaveLength(1);
    expect(cmp.failures[0]).toMatch(/spawnCount/);
  });

  it("fails when wallMs exceeds 1.25x baseline", () => {
    const cmp = compareToBaseline({ ...base, wallMs: 250_001 }, base);
    expect(cmp.ok).toBe(false);
    expect(cmp.failures[0]).toMatch(/wallMs/);
  });

  it("passes at exactly 1.25x baseline", () => {
    const cmp = compareToBaseline({ ...base, wallMs: 250_000 }, base);
    expect(cmp.ok).toBe(true);
  });

  it("passes when current.wallMs is undefined", () => {
    const cmp = compareToBaseline({ ...base, wallMs: undefined }, base);
    expect(cmp.ok).toBe(true);
  });

  it("passes when baseline.wallMs is undefined", () => {
    const cmp = compareToBaseline({ ...base, wallMs: 999_999_999 }, { ...base, wallMs: undefined });
    expect(cmp.ok).toBe(true);
  });

  it("fails when meanConfidence drops more than 0.1", () => {
    const cmp = compareToBaseline({ ...base, meanConfidence: 0.79 }, base);
    expect(cmp.ok).toBe(false);
    expect(cmp.failures[0]).toMatch(/meanConfidence/);
  });

  it("passes when meanConfidence drops exactly 0.1", () => {
    const cmp = compareToBaseline({ ...base, meanConfidence: 0.8 }, base);
    expect(cmp.ok).toBe(true);
  });

  it("collects multiple failures independently", () => {
    const cmp = compareToBaseline(
      { beatCount: 5, spawnCount: 6, wallMs: 200_000, meanConfidence: 0.5 },
      base,
    );
    expect(cmp.ok).toBe(false);
    expect(cmp.failures).toHaveLength(2);
    expect(cmp.failures.some((f) => /beatCount/.test(f))).toBe(true);
    expect(cmp.failures.some((f) => /meanConfidence/.test(f))).toBe(true);
  });
});

interface BaselineFile {
  readonly patternName: string;
  readonly sourceFile: string | null;
  readonly capturedAt: string | null;
  readonly metrics: RunMetrics | null;
}

describe("non-regression", () => {
  const patterns = ["feature", "investigate", "refactor"] as const;
  for (const pattern of patterns) {
    const baselinePath = path.resolve(__dirname, "baselines", `${pattern}.json`);
    const baseline: BaselineFile = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

    if (baseline.metrics === null) {
      it.skip(`${pattern}: baseline has no metrics (empty store) - refresh per baselines/README.md`, () => {});
      continue;
    }

    const baselineMetrics = baseline.metrics;
    it(`${pattern}: latest SavedRun beats all four baseline gates`, () => {
      const file = latestRunFile(pattern);
      if (file === undefined) {
        throw new Error(`expected SavedRun file for pattern '${pattern}'`);
      }
      if (baselineMetrics === null) {
        throw new Error(`expected baseline metrics for pattern '${pattern}'`);
      }
      const current = runMetrics(loadSavedRun(file));
      const cmp = compareToBaseline(current, baselineMetrics);
      expect(cmp.failures).toEqual([]);
      expect(cmp.ok).toBe(true);
    });
  }
});
