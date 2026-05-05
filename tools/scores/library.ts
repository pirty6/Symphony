/**
 * library.ts — ScoreLibrary index over the SavedRun store.
 *
 * The store layout
 *   tools/scores/store/<patternName>/<fp16>-<timestamp>.json
 * is filesystem-readable on its own, but for fast lookup we maintain
 * a single `tools/scores/index.json` that maps each saved run to its
 * pattern, problem fingerprint, outcome, and a few headline fields.
 *
 * Why pattern-first folders: scanning "all investigate runs" or
 * "all refactor runs" is the natural query. Loading is lazy per
 * pattern; the index keeps the whole-store summary cheap.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Level, PerformanceOutcome, Shape } from "../symphony/types";
import { loadRun } from "../symphony/persistence";

const STORE_DIR = path.join("tools", "scores", "store");
const INDEX_FILE = path.join("tools", "scores", "index.json");

export interface SavedRunIndexEntry {
  readonly scoreId: string;
  readonly pattern: string;
  readonly problemFingerprint: string;
  readonly timestamp: string;
  readonly file: string;
  readonly domain: string;
  readonly shape: Shape;
  readonly dominantLevels: readonly Level[];
  readonly outcome: PerformanceOutcome;
  readonly beats: number;
}

export interface ScoreLibraryIndex {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly entries: readonly SavedRunIndexEntry[];
}

function listSavedRunFiles(storeDir: string): readonly string[] {
  if (!fs.existsSync(storeDir)) return [];
  const out: string[] = [];
  const patternDirs = fs.readdirSync(storeDir, { withFileTypes: true });
  for (const dir of patternDirs) {
    if (!dir.isDirectory()) continue;
    const sub = path.join(storeDir, dir.name);
    const files = fs.readdirSync(sub, { withFileTypes: true });
    for (const f of files) {
      if (f.isFile() && f.name.endsWith(".json")) {
        out.push(path.join(sub, f.name));
      }
    }
  }
  return out;
}

/**
 * Walk the store and produce a fresh index. Files that fail to load
 * are skipped silently (likely in-progress writes); the verify CLI
 * is the place to surface those.
 */
export function buildLibraryIndex(
  storeDir: string = STORE_DIR,
): ScoreLibraryIndex {
  const files = listSavedRunFiles(storeDir);
  const entries: SavedRunIndexEntry[] = [];
  for (const file of files) {
    try {
      const run = loadRun(file);
      entries.push({
        scoreId: run.executableScore.id,
        pattern: run.patternScore.pattern,
        problemFingerprint: run.problemFingerprint,
        timestamp: run.timestamp,
        file: path.relative(".", file),
        domain: run.executableScore.frequencyMap.key,
        shape: run.executableScore.frequencyMap.shape,
        dominantLevels: run.executableScore.frequencyMap.dominantLevels,
        outcome: run.performance.outcome,
        beats: run.executableScore.beats.length,
      });
    } catch {
      // skip
    }
  }
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };
}

export function writeLibraryIndex(
  storeDir: string = STORE_DIR,
  indexFile: string = INDEX_FILE,
): ScoreLibraryIndex {
  const index = buildLibraryIndex(storeDir);
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n", "utf8");
  return index;
}

/** Load the persisted index from disk, or build it on the fly. */
export function loadLibraryIndex(
  indexFile: string = INDEX_FILE,
): ScoreLibraryIndex {
  if (!fs.existsSync(indexFile)) return buildLibraryIndex();
  const raw = fs.readFileSync(indexFile, "utf8");
  return JSON.parse(raw) as ScoreLibraryIndex;
}

/** Convenience: list runs for one pattern, newest first. */
export function findRunsByPattern(
  pattern: string,
  index: ScoreLibraryIndex = loadLibraryIndex(),
): readonly SavedRunIndexEntry[] {
  return index.entries
    .filter((e) => e.pattern === pattern)
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
