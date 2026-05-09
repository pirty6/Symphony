import * as fs from "node:fs";
import * as path from "node:path";
import { loadRun } from "../symphony/persistence";
import type { SavedRun } from "../symphony/types";

export interface RunMetrics {
  beatCount: number;
  spawnCount: number;
  wallMs: number | undefined;
  meanConfidence: number;
}

export interface BaselineComparison {
  ok: boolean;
  failures: string[];
}

const DEFAULT_STORE_DIR = path.resolve(__dirname, "store");

export function loadSavedRun(filePath: string): SavedRun {
  return loadRun(filePath);
}

export function runMetrics(run: SavedRun): RunMetrics {
  const beats = run.performance.beats;
  const beatCount = beats.length;
  let spawnCount = 0;
  let confidenceSum = 0;
  let voiceCount = 0;
  for (const beat of beats) {
    spawnCount += beat.voices.length;
    for (const voice of beat.voices) {
      confidenceSum += voice.confidence;
      voiceCount += 1;
    }
  }
  const meanConfidence = voiceCount === 0 ? 0 : confidenceSum / voiceCount;

  const startedAt = run.performance.startedAt;
  const completedAt = run.performance.completedAt;
  let wallMs: number | undefined;
  if (typeof startedAt === "string" && typeof completedAt === "string") {
    const start = Date.parse(startedAt);
    const end = Date.parse(completedAt);
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      wallMs = end - start;
    }
  }

  return { beatCount, spawnCount, wallMs, meanConfidence };
}

export function compareToBaseline(current: RunMetrics, baseline: RunMetrics): BaselineComparison {
  const failures: string[] = [];

  if (current.beatCount < baseline.beatCount) {
    failures.push(`beatCount ${current.beatCount} < baseline ${baseline.beatCount}`);
  }

  if (current.spawnCount < baseline.spawnCount) {
    failures.push(`spawnCount ${current.spawnCount} < baseline ${baseline.spawnCount}`);
  }

  if (
    current.wallMs !== undefined &&
    baseline.wallMs !== undefined &&
    current.wallMs > baseline.wallMs * 1.25
  ) {
    failures.push(
      `wallMs ${current.wallMs} > baseline ${baseline.wallMs} * 1.25 (${baseline.wallMs * 1.25})`,
    );
  }

  if (current.meanConfidence < baseline.meanConfidence - 0.1) {
    failures.push(
      `meanConfidence ${current.meanConfidence.toFixed(4)} < baseline ${baseline.meanConfidence.toFixed(4)} - 0.1`,
    );
  }

  return { ok: failures.length === 0, failures };
}

export function latestRunFile(
  pattern: string,
  storeDir: string = DEFAULT_STORE_DIR,
): string | undefined {
  const dir = path.join(storeDir, pattern);
  if (!fs.existsSync(dir)) {
    return undefined;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    return undefined;
  }
  const sortKey = (f: string): string => {
    const dash = f.indexOf("-");
    return dash === -1 ? f : f.slice(dash + 1);
  };
  files.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  return path.resolve(dir, files[0]);
}
