/**
 * meta-score.ts — The meta-score state machine.
 *
 * Given a GOAL + CONSTRAINTS + DOMAIN, walks through the 5 invariant
 * phases of algorithm design and emits a spec for human review,
 * then (on approval) emits the final score.sh + prompts.sh.
 *
 * Exit codes: 0 = success, 1 = fatal failure, 2 = judgment needed.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface MetaScoreInput {
  goal: string;
  domain?: string;
  constraints?: string;
  knowledgeContext?: string;

  // Re-invocation vars (one-shot, consumed on use)
  goalConfirmed?: string;
  successCondition?: string;
  constraintsConfirmed?: string;
  invariants?: string;
  degreesOfFreedom?: string;
  qualityCriteria?: string;
  problemClass?: string;
  strategiesRaw?: string;
  strategiesOrdered?: string;
  verifyHookConfirmed?: string;
  problemHooks?: string;
  strategyHooks?: string;
  specApproved?: string;
  scoreGenerated?: string;
  executionApproved?: string;
  skipPhase?: string;
}

export interface JudgmentOutput {
  judgmentType: string;
  reviewContext: Record<string, string>;
  composerInstructions: string;
  instrumentInstructions: string;
}

export interface ScoreResult {
  exitCode: 0 | 1 | 2;
  output: string;
  judgment?: JudgmentOutput;
}

export type PhaseHandler = (input: MetaScoreInput) => ScoreResult | null;

export enum MetaScorePhase {
  GoalDefinition = "goal-definition",
  ConstraintMapping = "constraint-mapping",
  ProblemClassification = "problem-classification",
  StrategyDiscovery = "strategy-discovery",
  StrategyOrdering = "strategy-ordering",
  VerifyHook = "verify-hook",
  ScoreEmission = "score-emission",
  ScoreExecution = "score-execution",
}

export interface PhaseRegistry {
  readonly entries: ReadonlyArray<{ phase: MetaScorePhase; handler: PhaseHandler }>;
  readonly size: number;
}

// ── Prompt imports ─────────────────────────────────────────────────

import {
  promptGoalClarificationComposer,
  promptGoalClarificationInstrument,
  promptConstraintMappingComposer,
  promptConstraintMappingInstrument,
  promptProblemClassificationComposer,
  promptProblemClassificationInstrument,
  promptStrategyDiscoveryComposer,
  promptStrategyDiscoveryInstrument,
  promptStrategyOrderingComposer,
  promptStrategyOrderingInstrument,
  promptVerifyHookComposer,
  promptVerifyHookInstrument,
  promptScoreEmissionComposer,
  promptScoreEmissionInstrument,
  promptScoreExecutionComposer,
  promptScoreExecutionInstrument,
} from "./prompts";

// ── Judgment emitter ───────────────────────────────────────────────

function buildAccumulatedFlags(input: MetaScoreInput): string {
  const flags: string[] = [`--goal "${input.goal}"`];
  if (input.domain) flags.push(`--domain "${input.domain}"`);
  if (input.constraints) flags.push(`--constraints "${input.constraints}"`);
  if (input.knowledgeContext) flags.push(`--knowledge-context "${input.knowledgeContext}"`);
  if (input.goalConfirmed) flags.push(`--goal-confirmed "${input.goalConfirmed}"`);
  if (input.successCondition) flags.push(`--success-condition "${input.successCondition}"`);
  if (input.constraintsConfirmed) flags.push(`--constraints-confirmed "${input.constraintsConfirmed}"`);
  if (input.invariants) flags.push(`--invariants "${input.invariants}"`);
  if (input.degreesOfFreedom) flags.push(`--degrees-of-freedom "${input.degreesOfFreedom}"`);
  if (input.qualityCriteria) flags.push(`--quality-criteria "${input.qualityCriteria}"`);
  if (input.problemClass) flags.push(`--problem-class "${input.problemClass}"`);
  if (input.strategiesRaw) flags.push(`--strategies-raw "${input.strategiesRaw}"`);
  if (input.strategiesOrdered) flags.push(`--strategies-ordered "${input.strategiesOrdered}"`);
  if (input.verifyHookConfirmed) flags.push(`--verify-hook-confirmed '${input.verifyHookConfirmed}'`);
  if (input.problemHooks) flags.push(`--problem-hooks '${input.problemHooks}'`);
  if (input.strategyHooks) flags.push(`--strategy-hooks '${input.strategyHooks}'`);
  if (input.specApproved) flags.push(`--spec-approved "${input.specApproved}"`);
  if (input.scoreGenerated) flags.push(`--score-generated "${input.scoreGenerated}"`);
  if (input.executionApproved) flags.push(`--execution-approved "${input.executionApproved}"`);
  return flags.join(" \\\n  ");
}

function judgment(
  type: string,
  composer: string,
  instrument: string,
  context: Record<string, string>,
  input: MetaScoreInput,
  newFlagHint: string,
): ScoreResult {
  const contextLines = Object.entries(context)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const accumulated = buildAccumulatedFlags(input);

  const output = [
    `JUDGMENT_REQUEST: ${type}`,
    "REVIEW_CONTEXT_BEGIN",
    contextLines,
    "REVIEW_CONTEXT_END",
    "ACCUMULATED_FLAGS_BEGIN",
    accumulated,
    "ACCUMULATED_FLAGS_END",
    `NEW_FLAGS_HINT: ${newFlagHint}`,
    `RE_INVOCATION_TEMPLATE: meta-score <ACCUMULATED_FLAGS> \\`,
    `  ${newFlagHint}`,
    `COMPOSER_INSTRUCTIONS_BEGIN`,
    composer,
    `COMPOSER_INSTRUCTIONS_END`,
    `INSTRUMENT_INSTRUCTIONS_BEGIN`,
    instrument,
    `INSTRUMENT_INSTRUCTIONS_END`,
  ].join("\n");

  return {
    exitCode: 2,
    output,
    judgment: {
      judgmentType: type,
      reviewContext: context,
      composerInstructions: composer,
      instrumentInstructions: instrument,
    },
  };
}

// ── Phase logic ────────────────────────────────────────────────────

function phaseGoalDefinition(input: MetaScoreInput): ScoreResult | null {
  if (input.goalConfirmed && input.successCondition) {
    return null; // Phase complete, advance
  }

  return judgment(
    "goal-clarification",
    promptGoalClarificationComposer(),
    promptGoalClarificationInstrument(),
    {
      GOAL: input.goal,
      ...(input.domain && { DOMAIN: input.domain }),
      ...(input.constraints && { CONSTRAINTS: input.constraints }),
      ...(input.knowledgeContext && { KNOWLEDGE_CONTEXT: input.knowledgeContext }),
    },
    input,
    '--goal-confirmed "<confirmed goal>" --success-condition "<what done looks like>"',
  );
}

function phaseConstraintMapping(input: MetaScoreInput): ScoreResult | null {
  if (input.constraintsConfirmed) {
    return null;
  }

  return judgment(
    "constraint-mapping",
    promptConstraintMappingComposer(),
    promptConstraintMappingInstrument(),
    {
      GOAL: input.goal,
      ...(input.goalConfirmed && { GOAL_CONFIRMED: input.goalConfirmed }),
      ...(input.successCondition && { SUCCESS_CONDITION: input.successCondition }),
      ...(input.domain && { DOMAIN: input.domain }),
      ...(input.constraints && { CONSTRAINTS: input.constraints }),
      ...(input.knowledgeContext && { KNOWLEDGE_CONTEXT: input.knowledgeContext }),
    },
    input,
    '--constraints-confirmed true --invariants "<list>" --degrees-of-freedom "<list>" --quality-criteria "<list>"',
  );
}

function phaseProblemClassification(input: MetaScoreInput): ScoreResult | null {
  if (input.problemClass) {
    return null;
  }

  return judgment(
    "problem-classification",
    promptProblemClassificationComposer(),
    promptProblemClassificationInstrument(),
    {
      GOAL: input.goal,
      ...(input.successCondition && { SUCCESS_CONDITION: input.successCondition }),
      ...(input.invariants && { INVARIANTS: input.invariants }),
      ...(input.degreesOfFreedom && { DEGREES_OF_FREEDOM: input.degreesOfFreedom }),
      ...(input.qualityCriteria && { QUALITY_CRITERIA: input.qualityCriteria }),
      ...(input.domain && { DOMAIN: input.domain }),
      ...(input.knowledgeContext && { KNOWLEDGE_CONTEXT: input.knowledgeContext }),
    },
    input,
    '--problem-class "<change_type>:<scope>:<known_shape_or_novel>"',
  );
}

function phaseStrategyDiscovery(input: MetaScoreInput): ScoreResult | null {
  if (input.strategiesRaw) {
    return null;
  }

  return judgment(
    "strategy-discovery",
    promptStrategyDiscoveryComposer(),
    promptStrategyDiscoveryInstrument(),
    {
      GOAL: input.goal,
      ...(input.successCondition && { SUCCESS_CONDITION: input.successCondition }),
      ...(input.invariants && { INVARIANTS: input.invariants }),
      ...(input.degreesOfFreedom && { DEGREES_OF_FREEDOM: input.degreesOfFreedom }),
      ...(input.qualityCriteria && { QUALITY_CRITERIA: input.qualityCriteria }),
      ...(input.problemClass && { PROBLEM_CLASS: input.problemClass }),
      ...(input.domain && { DOMAIN: input.domain }),
      ...(input.knowledgeContext && { KNOWLEDGE_CONTEXT: input.knowledgeContext }),
    },
    input,
    '--strategies-raw "<strategy1|strategy2|strategy3>"',
  );
}

function phaseStrategyOrdering(input: MetaScoreInput): ScoreResult | null {
  if (input.strategiesOrdered) {
    return null;
  }

  return judgment(
    "strategy-ordering",
    promptStrategyOrderingComposer(),
    promptStrategyOrderingInstrument(),
    {
      ...(input.strategiesRaw && { STRATEGIES_RAW: input.strategiesRaw }),
      ...(input.invariants && { INVARIANTS: input.invariants }),
      ...(input.qualityCriteria && { QUALITY_CRITERIA: input.qualityCriteria }),
      ...(input.domain && { DOMAIN: input.domain }),
      ...(input.knowledgeContext && { KNOWLEDGE_CONTEXT: input.knowledgeContext }),
    },
    input,
    '--strategies-ordered "<strategy1|strategy2|strategy3>"',
  );
}

function phaseVerifyHook(input: MetaScoreInput): ScoreResult | null {
  if (input.verifyHookConfirmed) {
    return null;
  }

  return judgment(
    "verify-hook-definition",
    promptVerifyHookComposer(),
    promptVerifyHookInstrument(),
    {
      ...(input.strategiesOrdered && { STRATEGIES_ORDERED: input.strategiesOrdered }),
      ...(input.successCondition && { SUCCESS_CONDITION: input.successCondition }),
      GOAL: input.goal,
      ...(input.domain && { DOMAIN: input.domain }),
      ...(input.knowledgeContext && { KNOWLEDGE_CONTEXT: input.knowledgeContext }),
    },
    input,
    `--verify-hook-confirmed true --problem-hooks '[{"verify":"<command>"}]' --strategy-hooks '[{"strategy":"<name>","verify":"<command>"}]'`,
  );
}

function phaseScoreEmission(input: MetaScoreInput): ScoreResult | null {
  if (input.scoreGenerated) {
    return null; // Score already generated, advance to execution
  }

  if (!input.specApproved) {
    // Emit the spec for human review — NOT the final score yet
    const spec = [
      "SPEC_BEGIN",
      `GOAL: ${input.goal}`,
      `SUCCESS_CONDITION: ${input.successCondition}`,
      `DOMAIN: ${input.domain ?? "general"}`,
      `INVARIANTS: ${input.invariants ?? "none specified"}`,
      `DEGREES_OF_FREEDOM: ${input.degreesOfFreedom ?? "none specified"}`,
      `QUALITY_CRITERIA: ${input.qualityCriteria ?? "none specified"}`,
      `STRATEGIES_ORDERED: ${input.strategiesOrdered}`,
      `PROBLEM_HOOKS: ${input.problemHooks ?? "none"}`,
      `STRATEGY_HOOKS: ${input.strategyHooks ?? "none"}`,
      "SPEC_END",
      "",
      "HUMAN_REVIEW_REQUIRED: Review the spec above. Re-invoke with SPEC_APPROVED=true to generate score.sh + prompts.sh.",
    ].join("\n");

    return judgment(
      "spec-review",
      promptScoreEmissionComposer(),
      promptScoreEmissionInstrument(),
      {
        SPEC: spec,
        KNOWLEDGE_CONTEXT: input.knowledgeContext ?? "",
      },
      input,
      '--spec-approved true',
    );
  }

  // Spec approved — emit the final score
  return judgment(
    "score-generation",
    promptScoreEmissionComposer(),
    promptScoreEmissionInstrument(),
    {
      SPEC_APPROVED: "true",
      GOAL: input.goal,
      SUCCESS_CONDITION: input.successCondition ?? "",
      STRATEGIES_ORDERED: input.strategiesOrdered ?? "",
      PROBLEM_HOOKS: input.problemHooks ?? "",
      STRATEGY_HOOKS: input.strategyHooks ?? "",
      INVARIANTS: input.invariants ?? "",
      DOMAIN: input.domain ?? "",
      KNOWLEDGE_CONTEXT: input.knowledgeContext ?? "",
    },
    input,
    '--score-generated true',
  );
}

function phaseScoreExecution(input: MetaScoreInput): ScoreResult | null {
  if (!input.specApproved) {
    return null; // Score emission hasn't happened yet — skip
  }

  if (!input.executionApproved) {
    return judgment(
      "score-execution",
      promptScoreExecutionComposer(),
      promptScoreExecutionInstrument(),
      {
        GOAL: input.goal,
        SUCCESS_CONDITION: input.successCondition ?? "",
        STRATEGIES_ORDERED: input.strategiesOrdered ?? "",
        PROBLEM_HOOKS: input.problemHooks ?? "",
        STRATEGY_HOOKS: input.strategyHooks ?? "",
        DOMAIN: input.domain ?? "",
        KNOWLEDGE_CONTEXT: input.knowledgeContext ?? "",
      },
      input,
      '--execution-approved true',
    );
  }

  // Execution approved — hand off to executor
  return {
    exitCode: 0,
    output: "META_SCORE_COMPLETE: Score generated and execution approved. The Composer should now spawn an Executor to run the generated symphony.",
  };
}

// ── Main state machine ─────────────────────────────────────────────

const phaseRegistry: PhaseRegistry = {
  entries: [
    { phase: MetaScorePhase.GoalDefinition, handler: phaseGoalDefinition },
    { phase: MetaScorePhase.ConstraintMapping, handler: phaseConstraintMapping },
    { phase: MetaScorePhase.ProblemClassification, handler: phaseProblemClassification },
    { phase: MetaScorePhase.StrategyDiscovery, handler: phaseStrategyDiscovery },
    { phase: MetaScorePhase.StrategyOrdering, handler: phaseStrategyOrdering },
    { phase: MetaScorePhase.VerifyHook, handler: phaseVerifyHook },
    { phase: MetaScorePhase.ScoreEmission, handler: phaseScoreEmission },
    { phase: MetaScorePhase.ScoreExecution, handler: phaseScoreExecution },
  ],
  size: 8,
};

const MAX_INVOCATIONS = phaseRegistry.size * 2;
let invocationCount = 0;

export function runMetaScore(input: MetaScoreInput): ScoreResult {
  invocationCount++;
  if (invocationCount > MAX_INVOCATIONS) {
    return {
      exitCode: 1,
      output: `META_SCORE_ERROR: Max invocations (${MAX_INVOCATIONS}) exceeded. Aborting.`,
    };
  }

  // Validate required input
  if (!input.goal) {
    return {
      exitCode: 1,
      output: "META_SCORE_ERROR: GOAL is required.",
    };
  }

  for (const { handler } of phaseRegistry.entries) {
    const result = handler(input);
    if (result !== null) {
      return result; // Phase needs judgment — pause
    }
  }

  // All phases complete
  return {
    exitCode: 0,
    output: "META_SCORE_COMPLETE: All phases finished successfully.",
  };
}

// ── Reset (for testing) ────────────────────────────────────────────

export function resetInvocationCount(): void {
  invocationCount = 0;
}
