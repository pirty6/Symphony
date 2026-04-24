/**
 * cli.ts — CLI entry point for the meta-score.
 *
 * Usage:
 *   npx tsx tools/meta-score/cli.ts --goal "<goal>" [--domain "<domain>"] [--constraints "<constraints>"]
 *
 * Re-invocation vars are passed as additional --key=value flags.
 * Exit codes mirror the state machine: 0 = done, 1 = error, 2 = judgment needed.
 */

import { runMetaScore } from "./meta-score";
import type { MetaScoreInput } from "./meta-score";

function parseArgs(argv: string[]): MetaScoreInput {
  const args = argv.slice(2);
  const input: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        // --key=value
        const key = arg.substring(2, eqIdx);
        input[key] = arg.substring(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        // --key value
        const key = arg.substring(2);
        input[key] = args[++i];
      }
    }
  }

  if (!input["goal"]) {
    console.error("Usage: npx tsx tools/meta-score/cli.ts --goal \"<goal>\" [--domain \"<domain>\"] [--constraints \"<constraints>\"]");
    process.exit(1);
  }

  // Map kebab-case CLI flags to camelCase MetaScoreInput fields
  return {
    goal: input["goal"],
    domain: input["domain"],
    constraints: input["constraints"],
    knowledgeContext: input["knowledge-context"] ?? input["knowledgeContext"],
    goalConfirmed: input["goal-confirmed"] ?? input["goalConfirmed"],
    successCondition: input["success-condition"] ?? input["successCondition"],
    constraintsConfirmed: input["constraints-confirmed"] ?? input["constraintsConfirmed"],
    invariants: input["invariants"],
    degreesOfFreedom: input["degrees-of-freedom"] ?? input["degreesOfFreedom"],
    qualityCriteria: input["quality-criteria"] ?? input["qualityCriteria"],
    strategiesRaw: input["strategies-raw"] ?? input["strategiesRaw"],
    strategiesOrdered: input["strategies-ordered"] ?? input["strategiesOrdered"],
    verifyHookConfirmed: input["verify-hook-confirmed"] ?? input["verifyHookConfirmed"],
    specApproved: input["spec-approved"] ?? input["specApproved"],
    scoreGenerated: input["score-generated"] ?? input["scoreGenerated"],
    executionApproved: input["execution-approved"] ?? input["executionApproved"],
    skipPhase: input["skip-phase"] ?? input["skipPhase"],
  };
}

const input = parseArgs(process.argv);
const result = runMetaScore(input);

console.log(result.output);
process.exit(result.exitCode);
