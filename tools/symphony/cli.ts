/**
 * cli.ts — Symphony command-line interface.
 *
 * Subcommands cover the data flow from pattern to persisted SavedRun:
 *
 *   list-patterns
 *   pattern view  --pattern <name> [--out <file.md>]
 *   from-pattern  --pattern <name> --input <input.json> --out <score.json>
 *   parse         --input <algorithm.json> --out <score.json>
 *   scaffold-performance --score <score.json> --out <performance.json>
 *   save-run      --pattern <name> --score <s.json> --performance <p.json>
 *   verify        --file <savedrun.json>
 *                 [--replay-against <fresh-performance.json>]
 *   library-index
 *
 * `from-pattern` and `parse` produce a loose ExecutableScore. The
 * Performance is filled in by maestro / the executor. `save-run`
 * wraps the two with a snapshot of the PatternScore and writes to
 * the canonical store path.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  detectDivergence,
  loadPerformance,
  loadRun,
  loadExecutableScore,
  reproduced,
  saveRun,
} from "./persistence";
import { writeLibraryIndex } from "../scores/library";
import { beatLegality } from "./legality";
import { parseAlgorithm, compileScore, type AlgorithmInput } from "../compiler/compile";
import { getPattern, listPatterns } from "../patterns";
import { renderPatternMarkdown } from "../patterns/render";
import { scaffoldPerformance } from "./perform";
import type { Beat, ExecutableScore, SavedRun } from "./types";

interface CliArgs {
  readonly command: string;
  readonly subcommand?: string;
  readonly score?: string;
  readonly performance?: string;
  readonly file?: string;
  readonly replayAgainst?: string;
  readonly input?: string;
  readonly out?: string;
  readonly pattern?: string;
  readonly json?: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "";
  let nextIdx = 1;
  let subcommand: string | undefined;
  if (args[1] && !args[1].startsWith("--")) {
    subcommand = args[1];
    nextIdx = 2;
  }
  const out: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = nextIdx; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.substring(2, eq)] = arg.substring(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      i += 1;
      out[arg.substring(2)] = args[i];
    } else {
      flags.add(arg.substring(2));
    }
  }
  return {
    command,
    subcommand,
    score: out["score"],
    performance: out["performance"],
    file: out["file"],
    replayAgainst: out["replay-against"],
    input: out["input"],
    out: out["out"],
    pattern: out["pattern"],
    json: flags.has("json"),
  };
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  symphony list-patterns        [--json]",
      "  symphony pattern view         --pattern <name> [--out <file.md>]",
      "  symphony from-pattern         --pattern <name> --input <input.json> --out <score.json>",
      "                                input.json: { problem: string, context?: object }",
      "  symphony parse                --input <algorithm.json> --out <score.json>",
      "  symphony scaffold-performance --score <score.json> --out <performance.json>",
      "  symphony save-run             --pattern <name> --score <s.json> --performance <p.json>",
      "  symphony verify               --file <savedrun.json> [--replay-against <fresh-performance.json>]",
      "  symphony library-index",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, undefined, 2) + "\n", "utf8");
}

function runFromPattern(args: CliArgs): number {
  const { pattern: patternName, input, out } = args;
  if (!patternName || !input || !out) {
    usage();
  }
  const pattern = getPattern(patternName);
  if (!pattern) {
    process.stderr.write(
      `UNKNOWN PATTERN: ${patternName}. Available: ${listPatterns()
        .map((p) => p.score.pattern)
        .join(", ")}\n`,
    );
    return 1;
  }
  let parsed: { problem?: string; context?: Record<string, unknown> };
  try {
    parsed = readJson(input);
  } catch (err) {
    process.stderr.write(`READ ERROR: ${(err as Error).message}\n`);
    return 1;
  }
  if (typeof parsed.problem !== "string" || parsed.problem.trim() === "") {
    process.stderr.write(
      `INPUT ERROR: --input file must be JSON of shape { problem: string, context?: object }\n`,
    );
    return 1;
  }
  let score: ExecutableScore;
  try {
    score = compileScore(pattern, {
      problem: parsed.problem,
      context: parsed.context,
    });
  } catch (err) {
    process.stderr.write(`COMPILE ERROR: ${(err as Error).message}\n`);
    return 1;
  }
  writeJson(out, score);
  process.stdout.write(
    `OK compiled (${pattern.score.pattern}):\n  scoreId        = ${score.id}\n  beats          = ${score.beats.length}\n  activeLevels   = [${score.frequencyMap.activeLevels.join(", ")}]\n  out            = ${out}\n`,
  );
  return 0;
}

function runParse(args: CliArgs): number {
  const { input, out } = args;
  if (!input || !out) {
    usage();
  }
  let parsed: AlgorithmInput;
  try {
    parsed = readJson(input);
  } catch (err) {
    process.stderr.write(`READ ERROR: ${(err as Error).message}\n`);
    return 1;
  }
  let score: ExecutableScore;
  try {
    score = parseAlgorithm(parsed);
  } catch (err) {
    process.stderr.write(`PARSE ERROR: ${(err as Error).message}\n`);
    return 1;
  }
  writeJson(out, score);
  process.stdout.write(
    `OK parsed:\n  scoreId        = ${score.id}\n  beats          = ${score.beats.length}\n  activeLevels   = [${score.frequencyMap.activeLevels.join(", ")}]\n  out            = ${out}\n`,
  );
  return 0;
}

function runScaffold(args: CliArgs): number {
  const { score: scoreFile, out } = args;
  if (!scoreFile || !out) {
    usage();
  }
  let score: ExecutableScore;
  try {
    score = loadExecutableScore(scoreFile);
  } catch (err) {
    process.stderr.write(`LOAD ERROR: ${(err as Error).message}\n`);
    return 1;
  }
  const performance = scaffoldPerformance(score);
  writeJson(out, performance);
  process.stdout.write(
    `OK scaffold:\n  scoreId  = ${performance.scoreId}\n  beats    = ${performance.beats.length}\n  outcome  = ${performance.outcome}\n  out      = ${out}\n`,
  );
  return 0;
}

function runSaveRun(args: CliArgs): number {
  const { pattern: patternName, score: scoreFile, performance: performanceFile } = args;
  if (!patternName || !scoreFile || !performanceFile) {
    usage();
  }
  const pattern = getPattern(patternName);
  if (!pattern) {
    process.stderr.write(`UNKNOWN PATTERN: ${patternName}\n`);
    return 1;
  }
  let score: ExecutableScore;
  let performance;
  try {
    score = loadExecutableScore(scoreFile);
    performance = loadPerformance(performanceFile);
  } catch (err) {
    process.stderr.write(`LOAD ERROR: ${(err as Error).message}\n`);
    return 1;
  }
  if (performance.scoreId !== score.id) {
    process.stderr.write(
      `MISMATCH: Performance.scoreId ${performance.scoreId} != ExecutableScore.id ${score.id}\n`,
    );
    return 1;
  }
  if (score.pattern !== pattern.score.pattern) {
    process.stderr.write(
      `MISMATCH: ExecutableScore.pattern "${score.pattern}" != requested pattern "${pattern.score.pattern}"\n`,
    );
    return 1;
  }
  const run: SavedRun = {
    schemaVersion: 1,
    patternScore: pattern.score,
    executableScore: score,
    performance,
    problemFingerprint: score.generatedFrom.canonicalHash,
    timestamp: score.generatedAt,
  };
  const file = saveRun(run);
  process.stdout.write(
    `OK saved:\n  pattern  = ${run.patternScore.pattern}\n  scoreId  = ${run.executableScore.id}\n  outcome  = ${run.performance.outcome}\n  file     = ${file}\n`,
  );
  return 0;
}

function validateScoreShape(score: ExecutableScore): string[] {
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
  const { file } = args;
  if (!file) {
    usage();
  }
  let run: SavedRun;
  try {
    run = loadRun(file);
  } catch (err) {
    process.stderr.write(`LOAD ERROR: ${(err as Error).message}\n`);
    return 1;
  }
  const errors = validateScoreShape(run.executableScore);
  if (errors.length > 0) {
    process.stderr.write("SCORE VALIDATION ERRORS:\n");
    for (const e of errors) {
      process.stderr.write(`  - ${e}\n`);
    }
    return 1;
  }
  process.stdout.write(
    `OK round-trip:\n` +
      `  pattern      = ${run.patternScore.pattern}\n` +
      `  scoreId      = ${run.executableScore.id}\n` +
      `  beats        = ${run.executableScore.beats.length}\n` +
      `  performance  = ${run.performance.outcome} (${run.performance.beats.length} beats)\n`,
  );
  if (args.replayAgainst) {
    let fresh;
    try {
      fresh = loadPerformance(args.replayAgainst);
    } catch (err) {
      process.stderr.write(`REPLAY LOAD ERROR: ${(err as Error).message}\n`);
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

function runLibraryIndex(): number {
  const index = writeLibraryIndex();
  process.stdout.write(
    `OK indexed:\n  entries = ${index.entries.length}\n  out     = tools/scores/index.json\n`,
  );
  return 0;
}

function runListPatterns(args: CliArgs): number {
  const patterns = listPatterns();
  if (args.json) {
    const out = patterns.map((p) => ({
      pattern: p.score.pattern,
      domain: p.score.domain,
      description: p.description,
      requiredContext: p.requiredContext,
      beats: p.score.beats.length,
    }));
    process.stdout.write(JSON.stringify(out, undefined, 2) + "\n");
    return 0;
  }
  process.stdout.write(`Available patterns (${patterns.length}):\n`);
  for (const p of patterns) {
    const reqd = p.requiredContext.length > 0 ? p.requiredContext.join(",") : "\u2014";
    process.stdout.write(
      `  ${p.score.pattern.padEnd(14)} domain=${p.score.domain.padEnd(16)} requiredContext=${reqd}\n`,
    );
    process.stdout.write(`    ${p.description}\n`);
  }
  return 0;
}

function runPatternView(args: CliArgs): number {
  if (args.subcommand !== "view") {
    usage();
  }
  if (!args.pattern) {
    usage();
  }
  const pattern = getPattern(args.pattern);
  if (!pattern) {
    process.stderr.write(`UNKNOWN PATTERN: ${args.pattern}\n`);
    return 1;
  }
  const md = renderPatternMarkdown(pattern);
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, md, "utf8");
    process.stdout.write(
      `OK rendered:\n  pattern = ${pattern.score.pattern}\n  out     = ${args.out}\n`,
    );
  } else {
    process.stdout.write(md);
  }
  return 0;
}

function main(): void {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "list-patterns":
      process.exit(runListPatterns(args));
    // eslint-disable-next-line no-fallthrough
    case "pattern":
      process.exit(runPatternView(args));
    // eslint-disable-next-line no-fallthrough
    case "from-pattern":
      process.exit(runFromPattern(args));
    // eslint-disable-next-line no-fallthrough
    case "parse":
      process.exit(runParse(args));
    // eslint-disable-next-line no-fallthrough
    case "scaffold-performance":
      process.exit(runScaffold(args));
    // eslint-disable-next-line no-fallthrough
    case "save-run":
      process.exit(runSaveRun(args));
    // eslint-disable-next-line no-fallthrough
    case "verify":
      process.exit(runVerify(args));
    // eslint-disable-next-line no-fallthrough
    case "library-index":
      process.exit(runLibraryIndex());
    // eslint-disable-next-line no-fallthrough
    default:
      usage();
  }
}

main();
