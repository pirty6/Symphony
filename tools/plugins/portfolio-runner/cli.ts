/**
 * cli.ts — CLI entry for portfolio-runner.
 *
 * Usage:
 *   npx tsx tools/plugins/portfolio-runner/cli.ts \
 *     --candidates-json <path-or-inline-json> \
 *     [--capital 100000] [--max-loss-pct 20] [--seed 42] \
 *     [--iterations 1000] [--max-portfolio-size 3] \
 *     [--correlation-penalty 0.5] [--shape put-spread-hedge]
 *
 * The --candidates-json input can be either:
 *   • a path to a JSON file containing ScreenedCandidate[]
 *   • an inline JSON array
 *   • a path to the raw screener output containing CANDIDATES_JSON_BEGIN/END
 *
 * --iterations: Monte-Carlo iterations per (candidate, strategy) sim.
 *   Default 1000 — biased toward fast feedback loops (full pipeline runs in
 *   seconds, suitable for development and watchlist sweeps). For decision-
 *   grade Sortino estimates pass --iterations 10000; the standard error on a
 *   Sortino ratio scales roughly as 1/√N, so 10× more iterations cuts noise
 *   by ~3.2×. Above 10000, runtime cost grows faster than precision gain.
 *   Defaults are intentionally NOT raised here — bumping the project default
 *   to 10000 would make the test suite ~10× slower for any test that drives
 *   the optimizer end-to-end. The flag is the right knob; the default is
 *   tuned for iteration speed, not for production decisions.
 *
 * Exit codes: 0 = portfolio emitted, 1 = fatal error, 2 = judgment requested.
 */

import * as fs from "node:fs";
import { runPortfolio, type PortfolioInputs } from "./score";
import type { ScreenedCandidate } from "../candidate-screener/score";

interface RawArgs {
  [key: string]: string;
}

function parseArgs(argv: string[]): RawArgs {
  const args = argv.slice(2);
  const out: RawArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.substring(2, eq)] = arg.substring(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      out[arg.substring(2)] = args[++i];
    } else {
      out[arg.substring(2)] = "true";
    }
  }
  return out;
}

function extractCandidatesJson(raw: string): string {
  const begin = raw.indexOf("CANDIDATES_JSON_BEGIN\n");
  const end = raw.indexOf("\nCANDIDATES_JSON_END");
  if (begin !== -1 && end !== -1) {
    return raw.substring(begin + "CANDIDATES_JSON_BEGIN\n".length, end);
  }
  return raw;
}

function loadCandidates(arg: string | undefined): ScreenedCandidate[] {
  if (!arg) {
    console.error("PORTFOLIO_ERROR: missing required flag --candidates-json");
    process.exit(1);
  }
  let raw: string;
  if (arg.trim().startsWith("[")) {
    raw = arg;
  } else {
    try {
      raw = fs.readFileSync(arg, "utf8");
    } catch (err) {
      console.error(`PORTFOLIO_ERROR: cannot read --candidates-json: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  const json = extractCandidatesJson(raw);
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      console.error("PORTFOLIO_ERROR: --candidates-json must be a JSON array");
      process.exit(1);
    }
    return parsed as ScreenedCandidate[];
  } catch (err) {
    console.error(`PORTFOLIO_ERROR: --candidates-json is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
}

function num(raw: RawArgs, key: string, fallback: number): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`PORTFOLIO_ERROR: --${key} must be a number, got "${v}"`);
    process.exit(1);
  }
  return n;
}

export function buildInputs(argv: string[]): PortfolioInputs {
  const raw = parseArgs(argv);
  const candidates = loadCandidates(raw["candidates-json"]);
  return {
    candidates,
    capital: num(raw, "capital", 100_000),
    maxLossPct: num(raw, "max-loss-pct", 20),
    seed: Math.trunc(num(raw, "seed", 42)),
    iterations: Math.trunc(num(raw, "iterations", 1000)),
    maxPortfolioSize: Math.trunc(
      num(raw, "max-portfolio-size", Math.min(3, candidates.length)),
    ),
    correlationPenaltyWeight: num(raw, "correlation-penalty", 0.5),
    shapeName: raw["shape"],
  };
}

if (require.main === module) {
  const inputs = buildInputs(process.argv);
  const result = runPortfolio(inputs);
  console.log(result.output);
  process.exit(result.exitCode);
}
