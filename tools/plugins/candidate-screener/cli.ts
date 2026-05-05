/**
 * cli.ts — CLI for the candidate-screener Symphony Score.
 *
 * Usage:
 *   npx tsx tools/plugins/candidate-screener/cli.ts \
 *     --watchlist-json <path-or-inline-json> \
 *     --week-of YYYY-MM-DD \
 *     [--seed 42] [--min-iv-rank 50] \
 *     [--price-min 20] [--price-max 500] \
 *     [--sector-cap 1] [--event-window-days 7]
 *
 * Exit codes: 0 = candidates emitted, 1 = fatal validation error, 2 = no candidates (judgment).
 */

import * as fs from "node:fs";
import { runScreener, type RawCandidate, type ScreenerInputs } from "./score";

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

function loadWatchlist(arg: string | undefined): RawCandidate[] {
  if (!arg) {
    console.error("SCREENER_ERROR: missing required flag --watchlist-json");
    process.exit(1);
  }
  let raw: string;
  if (arg.trim().startsWith("[")) {
    raw = arg;
  } else {
    try {
      raw = fs.readFileSync(arg, "utf8");
    } catch (err) {
      console.error(`SCREENER_ERROR: cannot read --watchlist-json: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error("SCREENER_ERROR: --watchlist-json must be a JSON array");
      process.exit(1);
    }
    return parsed as RawCandidate[];
  } catch (err) {
    console.error(`SCREENER_ERROR: --watchlist-json is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
}

function num(raw: RawArgs, key: string, fallback: number): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`SCREENER_ERROR: --${key} must be a number, got "${v}"`);
    process.exit(1);
  }
  return n;
}

export function buildInputs(argv: string[]): ScreenerInputs {
  const raw = parseArgs(argv);
  const weekOf = raw["week-of"];
  if (!weekOf) {
    console.error("SCREENER_ERROR: missing required flag --week-of YYYY-MM-DD");
    process.exit(1);
  }
  return {
    watchlist: loadWatchlist(raw["watchlist-json"]),
    weekOf,
    seed: Math.trunc(num(raw, "seed", 42)),
    minIvRank: num(raw, "min-iv-rank", 50),
    priceMin: num(raw, "price-min", 20),
    priceMax: num(raw, "price-max", 500),
    sectorCap: Math.trunc(num(raw, "sector-cap", 1)),
    eventWindowDays: Math.trunc(num(raw, "event-window-days", 7)),
  };
}

if (require.main === module) {
  const inputs = buildInputs(process.argv);
  const result = runScreener(inputs);
  console.log(result.output);
  process.exit(result.exitCode);
}
