import * as fs from "node:fs";
import { saveRun } from "./persistence";
import type { SavedRun, PatternScore } from "./types";

try {
  const raw = fs.readFileSync("/tmp/update-package-fix.state.json", "utf8");
  const state = JSON.parse(raw);

  if (state.kind !== "done") {
    console.error("State is not done:", state.kind);
    process.exit(1);
  }

  const { executableScore, performance, patternScore } = state.result;

  const finalPatternScore: PatternScore = patternScore || {
    pattern: executableScore.pattern,
    domain: executableScore.frequencyMap?.key || "unknown",
    beats: []
  };

  const run: SavedRun = {
    schemaVersion: 1,
    patternScore: finalPatternScore,
    executableScore,
    performance,
    problemFingerprint: executableScore.generatedFrom.canonicalHash,
    timestamp: executableScore.generatedAt,
  };

  const file = saveRun(run);
  console.log("SUCCESS: saved to", file);
} catch (err) {
  console.error("FAILED:", (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
}
