/**
 * cli.ts — `symphony verify` round-trip CLI.
 *
 * The minimum-runnable artifact for v1. Takes a hand-authored Score and
 * a captured Performance, loads them, validates the round-trip, and
 * reports a DivergenceReport. No LLM calls. No agent orchestration.
 * Just persistence and structural validation.
 *
 * Usage:
 *   npx tsx tools/symphony/cli.ts verify \
 *     --score path/to/score.json \
 *     --performance path/to/performance.json
 *
 *   npx tsx tools/symphony/cli.ts verify --dir path/to/run-directory
 *
 * Exit codes:
 *   0 — round-trip clean (loaded, schemaVersion accepted, ids match)
 *   1 — usage error or load failure
 *   2 — divergence detected (only meaningful when --replay-against is
 *       supplied; reserved for the next CLI iteration)
 */

import * as path from "node:path";

import {
  detectDivergence,
  loadPerformance,
  loadRun,
  loadScore,
  reproduced,
} from "./persistence";
import { beatLegality } from "./legality";
import type { Beat, Score } from "./types";

interface CliArgs {
  readonly command: string;
  readonly score?: string;
  readonly performance?: string;
  readonly dir?: string;
  readonly replayAgainst?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "";
  const out: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.substring(2, eq)] = arg.substring(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      out[arg.substring(2)] = args[++i];
    }
  }
  return {
    command,
    score: out["score"],
    performance: out["performance"],
    dir: out["dir"],
    replayAgainst: out["replay-against"],
  };
}

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  symphony verify --dir <run-directory>",
      "  symphony verify --score <score.json> --performance <performance.json>",
      "",
      "  Optional: --replay-against <fresh-performance.json>",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function validateScoreShape(score: Score): string[] {
  const errors: string[] = [];
  if (score.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion ${score.schemaVersion}`);
  }
  score.beats.forEach((beat: Beat, idx: number) => {
    if (beat.voices.length === 0) {
      errors.push(`beat ${idx}: must have at least one voice`);
    }
    if (beatLegality(beat.level, beat.voices) === "illegal") {
      errors.push(
        `beat ${idx}: illegal (level=${beat.level}, voices=${beat.voices
          .map((v) => v.instrument)
          .join("+")})`,
      );
    }
  });
  return errors;
}

function runVerify(args: CliArgs): number {
  let scorePath: string;
  let performancePath: string;

  if (args.dir) {
    scorePath = path.join(args.dir, "score.json");
    performancePath = path.join(args.dir, "performance.json");
  } else if (args.score && args.performance) {
    scorePath = args.score;
    performancePath = args.performance;
  } else {
    usage();
  }

  let run;
  try {
    if (args.dir) {
      run = loadRun(args.dir);
    } else {
      const score = loadScore(scorePath);
      const performance = loadPerformance(performancePath);
      if (performance.scoreId !== score.id) {
        process.stderr.write(
          `LOAD ERROR: Performance.scoreId ${performance.scoreId} != Score.id ${score.id}\n`,
        );
        return 1;
      }
      run = { score, performance };
    }
  } catch (err) {
    process.stderr.write(`LOAD ERROR: ${(err as Error).message}\n`);
    return 1;
  }

  const errors = validateScoreShape(run.score);
  if (errors.length > 0) {
    process.stderr.write("SCORE VALIDATION ERRORS:\n");
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return 1;
  }

  process.stdout.write(
    `OK round-trip:\n` +
      `  scoreId      = ${run.score.id}\n` +
      `  beats        = ${run.score.beats.length}\n` +
      `  performance  = ${run.performance.outcome} (${run.performance.beats.length} beats)\n`,
  );

  if (args.replayAgainst) {
    let fresh;
    try {
      fresh = loadPerformance(args.replayAgainst);
    } catch (err) {
      process.stderr.write(
        `REPLAY LOAD ERROR: ${(err as Error).message}\n`,
      );
      return 1;
    }
    const report = detectDivergence(run.performance, fresh);
    process.stdout.write(
      `DIVERGENCE:\n` +
        `  structural    = ${report.structural}\n` +
        `  semantic      = ${report.semantic.length}\n` +
        `  environmental = ${report.environmental.length}\n` +
        `  prose         = ${report.prose}\n` +
        `  reproduced    = ${reproduced(report)}\n`,
    );
    return reproduced(report) ? 0 : 2;
  }

  return 0;
}

function main(): void {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "verify":
      process.exit(runVerify(args));
    // eslint-disable-next-line no-fallthrough
    default:
      usage();
  }
}

main();
