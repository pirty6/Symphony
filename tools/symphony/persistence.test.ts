/**
 * persistence.test.ts — saveRun / loadRun / library round-trip.
 *
 * Uses a tmp dir per test for isolation. Verifies the canonical
 * tools/scores/store/<pattern>/<fp16>-<timestamp>.json layout, the
 * single-file SavedRun JSON shape, and the consistency checks loadRun
 * enforces (scoreId match, beatIndex sequence, schemaVersion).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadRun,
  saveRun,
  savedRunPath,
  loadExecutableScore,
  loadPerformance,
} from "./persistence";
import { compileScore } from "../compiler/compile";
import { scaffoldPerformance } from "./perform";
import { investigatePattern, refactorPattern } from "../patterns";
import { buildLibraryIndex } from "../scores/library";
import type { Performance, SavedRun } from "./types";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "symphony-test-"));
}

function buildSavedRun(pattern = investigatePattern): SavedRun {
  const score =
    pattern === investigatePattern
      ? compileScore(pattern, { problem: "p", generatedAt: FIXED_TS })
      : compileScore(pattern, {
          problem: "p",
          context: { target: "t", invariant: "i" },
          generatedAt: FIXED_TS,
        });
  const performance = scaffoldPerformance(score);
  return {
    schemaVersion: 1,
    patternScore: pattern.score,
    executableScore: score,
    performance,
    problemFingerprint: score.generatedFrom.canonicalHash,
    timestamp: score.generatedAt,
  };
}

describe("savedRunPath", () => {
  test("encodes pattern as folder, fp16+timestamp as filename", () => {
    const run = buildSavedRun();
    const file = savedRunPath(run, "/tmp/store");
    expect(file.startsWith("/tmp/store/investigate/")).toBe(true);
    expect(file.endsWith(".json")).toBe(true);
    const base = path.basename(file, ".json");
    const [fp16, ...rest] = base.split("-");
    expect(fp16).toHaveLength(16);
    expect(rest.length).toBeGreaterThan(0);
  });

  test("escapes colons and dots in timestamp for filesystem safety", () => {
    const run = buildSavedRun();
    const file = savedRunPath(run, "/tmp/store");
    expect(file).not.toMatch(/[:.](?!json$)/);
  });
});

describe("saveRun → loadRun round-trip", () => {
  test("writes a single JSON file containing the whole SavedRun", () => {
    const tmp = makeTmpDir();
    const run = buildSavedRun();
    const file = saveRun(run, tmp);
    expect(fs.existsSync(file)).toBe(true);

    const dir = path.join(tmp, "investigate");
    expect(fs.readdirSync(dir).length).toBe(1);

    const loaded = loadRun(file);
    expect(loaded.executableScore.id).toBe(run.executableScore.id);
    expect(loaded.patternScore.pattern).toBe("investigate");
    expect(loaded.problemFingerprint).toBe(run.problemFingerprint);
    expect(loaded.performance.scoreId).toBe(run.executableScore.id);
  });

  test("round-trips refactor with context preserved", () => {
    const tmp = makeTmpDir();
    const run = buildSavedRun(refactorPattern);
    const file = saveRun(run, tmp);
    const loaded = loadRun(file);
    expect(loaded.executableScore.context).toEqual({ target: "t", invariant: "i" });
    expect(loaded.patternScore.pattern).toBe("refactor");
  });

  test("loadRun rejects mismatched scoreId", () => {
    const tmp = makeTmpDir();
    const run = buildSavedRun();
    const file = saveRun(run, tmp);
    const corrupted = JSON.parse(fs.readFileSync(file, "utf8")) as SavedRun;
    const tamperedPerformance: Performance = { ...corrupted.performance, scoreId: "deadbeef" };
    const tampered = {
      ...corrupted,
      performance: tamperedPerformance,
    };
    fs.writeFileSync(file, JSON.stringify(tampered));
    expect(() => loadRun(file)).toThrow(/does not match/);
  });

  test("loadRun rejects out-of-order beatIndex", () => {
    const tmp = makeTmpDir();
    const run = buildSavedRun();
    const file = saveRun(run, tmp);
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as SavedRun;
    const beats = [...data.performance.beats];
    if (beats.length < 2) {return;} // not exercising on degenerate runs
    const swappedPerformance: Performance = {
      ...data.performance,
      beats: [beats[1], beats[0], ...beats.slice(2)],
    };
    const swapped = {
      ...data,
      performance: swappedPerformance,
    };
    fs.writeFileSync(file, JSON.stringify(swapped));
    expect(() => loadRun(file)).toThrow(/beatIndex/);
  });

  test("loadRun rejects unsupported schemaVersion", () => {
    const tmp = makeTmpDir();
    const run = buildSavedRun();
    const file = saveRun(run, tmp);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...data, schemaVersion: 2 }));
    expect(() => loadRun(file)).toThrow(/schemaVersion/);
  });
});

describe("loadExecutableScore / loadPerformance", () => {
  test("load each component file from a SavedRun dump", () => {
    const tmp = makeTmpDir();
    const run = buildSavedRun();
    const scoreFile = path.join(tmp, "score.json");
    const perfFile = path.join(tmp, "perf.json");
    fs.writeFileSync(scoreFile, JSON.stringify(run.executableScore));
    fs.writeFileSync(perfFile, JSON.stringify(run.performance));

    const score = loadExecutableScore(scoreFile);
    const performance = loadPerformance(perfFile);
    expect(score.id).toBe(run.executableScore.id);
    expect(performance.scoreId).toBe(run.executableScore.id);
  });
});

describe("buildLibraryIndex", () => {
  test("indexes runs across multiple pattern folders", () => {
    const tmp = makeTmpDir();
    saveRun(buildSavedRun(investigatePattern), tmp);
    saveRun(buildSavedRun(refactorPattern), tmp);

    const index = buildLibraryIndex(tmp);
    expect(index.schemaVersion).toBe(1);
    expect(index.entries.length).toBe(2);
    const patterns = index.entries.map((e) => e.pattern).sort();
    expect(patterns).toEqual(["investigate", "refactor"]);
    for (const e of index.entries) {
      expect(e.scoreId).toMatch(/^[0-9a-f]{64}$/);
      expect(e.beats).toBeGreaterThan(0);
    }
  });

  test("returns empty index for missing store dir", () => {
    const index = buildLibraryIndex(path.join(os.tmpdir(), "does-not-exist-xyz"));
    expect(index.entries).toEqual([]);
  });
});
