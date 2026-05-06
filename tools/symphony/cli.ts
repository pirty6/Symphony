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
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

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

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, undefined, 2) + "\n", "utf8");
}

function runFromPattern(opts: {
  readonly pattern: string;
  readonly input: string;
  readonly out: string;
}): number {
  const { pattern: patternName, input, out } = opts;
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

function runParse(opts: { readonly input: string; readonly out: string }): number {
  const { input, out } = opts;
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

function runScaffold(opts: { readonly score: string; readonly out: string }): number {
  const { score: scoreFile, out } = opts;
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

function runSaveRun(opts: {
  readonly pattern: string;
  readonly score: string;
  readonly performance: string;
}): number {
  const { pattern: patternName, score: scoreFile, performance: performanceFile } = opts;
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

function runVerify(opts: { readonly file: string; readonly replayAgainst?: string }): number {
  const { file } = opts;
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
  if (opts.replayAgainst) {
    let fresh;
    try {
      fresh = loadPerformance(opts.replayAgainst);
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

function runListPatterns(opts: { readonly json: boolean }): number {
  const patterns = listPatterns();
  if (opts.json) {
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

function runPatternView(opts: { readonly pattern: string; readonly out?: string }): number {
  const pattern = getPattern(opts.pattern);
  if (!pattern) {
    process.stderr.write(`UNKNOWN PATTERN: ${opts.pattern}\n`);
    return 1;
  }
  const md = renderPatternMarkdown(pattern);
  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, md, "utf8");
    process.stdout.write(
      `OK rendered:\n  pattern = ${pattern.score.pattern}\n  out     = ${opts.out}\n`,
    );
  } else {
    process.stdout.write(md);
  }
  return 0;
}

function main(): void {
  yargs(hideBin(process.argv))
    .scriptName("symphony")
    .strict()
    .version(false)
    .command(
      "list-patterns",
      "List registered patterns (with descriptions and required context)",
      (y) =>
        y.option("json", {
          describe: "Emit machine-readable JSON instead of the human summary",
          type: "boolean",
          default: false,
        }),
      (a) => process.exit(runListPatterns({ json: a.json })),
    )
    .command(
      "pattern <subcommand>",
      "Pattern operations",
      (y) =>
        y
          .positional("subcommand", {
            describe: "Pattern operation",
            choices: ["view"] as const,
            demandOption: true,
          })
          .option("pattern", {
            describe: "Pattern name",
            type: "string",
            demandOption: true,
          })
          .option("out", {
            describe: "Optional file path; otherwise prints to stdout",
            type: "string",
          }),
      (a) => process.exit(runPatternView({ pattern: a.pattern, out: a.out })),
    )
    .command(
      "from-pattern",
      "Compile a registered Pattern + input.json into an ExecutableScore",
      (y) =>
        y
          .option("pattern", { describe: "Pattern name", type: "string", demandOption: true })
          .option("input", {
            describe: "Input JSON: { problem: string, context?: object }",
            type: "string",
            demandOption: true,
          })
          .option("out", {
            describe: "Output ExecutableScore JSON path",
            type: "string",
            demandOption: true,
          }),
      (a) => process.exit(runFromPattern({ pattern: a.pattern, input: a.input, out: a.out })),
    )
    .command(
      "parse",
      "Parse an algorithm.json into an ExecutableScore",
      (y) =>
        y
          .option("input", {
            describe: "Input algorithm JSON",
            type: "string",
            demandOption: true,
          })
          .option("out", {
            describe: "Output ExecutableScore JSON path",
            type: "string",
            demandOption: true,
          }),
      (a) => process.exit(runParse({ input: a.input, out: a.out })),
    )
    .command(
      "scaffold-performance",
      "Scaffold an empty Performance from an ExecutableScore",
      (y) =>
        y
          .option("score", {
            describe: "ExecutableScore JSON path",
            type: "string",
            demandOption: true,
          })
          .option("out", {
            describe: "Output Performance JSON path",
            type: "string",
            demandOption: true,
          }),
      (a) => process.exit(runScaffold({ score: a.score, out: a.out })),
    )
    .command(
      "save-run",
      "Persist a SavedRun (pattern + score + performance) to the canonical store",
      (y) =>
        y
          .option("pattern", { describe: "Pattern name", type: "string", demandOption: true })
          .option("score", {
            describe: "ExecutableScore JSON path",
            type: "string",
            demandOption: true,
          })
          .option("performance", {
            describe: "Performance JSON path",
            type: "string",
            demandOption: true,
          }),
      (a) =>
        process.exit(
          runSaveRun({ pattern: a.pattern, score: a.score, performance: a.performance }),
        ),
    )
    .command(
      "verify",
      "Verify a SavedRun; optionally compare against a fresh Performance",
      (y) =>
        y
          .option("file", {
            describe: "SavedRun JSON path",
            type: "string",
            demandOption: true,
          })
          .option("replay-against", {
            describe: "Optional fresh Performance JSON to diff against",
            type: "string",
          }),
      (a) => process.exit(runVerify({ file: a.file, replayAgainst: a["replay-against"] })),
    )
    .command(
      "library-index",
      "Rebuild tools/scores/index.json from saved runs",
      (y) => y,
      () => process.exit(runLibraryIndex()),
    )
    .demandCommand(1, "Specify a subcommand.")
    .help()
    .parse();
}

main();
