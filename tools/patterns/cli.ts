/**
 * cli.ts — Pattern catalog command-line interface.
 *
 * Read-only access to the registered Pattern catalog. Both maestro
 * (engine routing) and symphony (score compilation, persistence)
 * consume the catalog as a library, but neither owns the CLI surface.
 *
 *   patterns list                 [--json]
 *   patterns view --pattern <name> [--out <file.md>]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { getPattern, listPatterns } from "./index";
import { renderPatternMarkdown } from "./render";
import { appendLog } from "../cli-shared/log";

function runList(opts: { readonly json: boolean }): number {
  appendLog("patterns", "list", "input", { json: opts.json });
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
    appendLog("patterns", "list", "output", { count: patterns.length, format: "json" });
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
  appendLog("patterns", "list", "output", { count: patterns.length, format: "text" });
  return 0;
}

function runView(opts: { readonly pattern: string; readonly out?: string }): number {
  appendLog("patterns", "view", "input", { pattern: opts.pattern, out: opts.out });
  const pattern = getPattern(opts.pattern);
  if (!pattern) {
    appendLog("patterns", "view", "output", { kind: "unknown", pattern: opts.pattern });
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
    appendLog("patterns", "view", "output", { kind: "file", out: opts.out });
  } else {
    process.stdout.write(md);
    appendLog("patterns", "view", "output", { kind: "stdout" });
  }
  return 0;
}

function main(): void {
  yargs(hideBin(process.argv))
    .scriptName("patterns")
    .strict()
    .version(false)
    .command(
      "list",
      "List registered patterns (with descriptions and required context)",
      (y) =>
        y.option("json", {
          describe: "Emit machine-readable JSON instead of the human summary",
          type: "boolean",
          default: false,
        }),
      (a) => process.exit(runList({ json: a.json })),
    )
    .command(
      "view",
      "Render a registered pattern as markdown",
      (y) =>
        y
          .option("pattern", {
            describe: "Pattern name",
            type: "string",
            demandOption: true,
          })
          .option("out", {
            describe: "Optional file path; otherwise prints to stdout",
            type: "string",
          }),
      (a) => process.exit(runView({ pattern: a.pattern, out: a.out })),
    )
    .demandCommand(1, "Specify a subcommand: `list` or `view`.")
    .help()
    .parse();
}

main();
