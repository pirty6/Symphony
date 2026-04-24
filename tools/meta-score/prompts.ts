/**
 * prompts.ts — Paired prompt templates for the meta-score.
 *
 * Every judgment type has both a _composer and _instrument function.
 * Every _instrument declares ALLOWED TOOLS.
 * Both return non-empty strings.
 */

// ── Phase 1: Goal Clarification ────────────────────────────────────

export function promptGoalClarificationComposer(): string {
  return `You received a goal that needs clarification before it can be turned into a strategy ladder.

Spawn an Assessor with the INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT blocks.

Based on the Assessor's findings:
- If the goal IS concrete: use the RE_INVOCATION_TEMPLATE from the output. Copy the ACCUMULATED_FLAGS block as-is and append the NEW_FLAGS filled with the Assessor's values:
  --goal-confirmed "<assessor's confirmed goal>" --success-condition "<assessor's success condition>"
- If the goal is NOT concrete: ask the user for clarification. Do NOT guess.`;
}

export function promptGoalClarificationInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir.

Analyze the GOAL in the review context. Determine:

1. CONCRETE: Is this goal specific enough to verify completion? (YES/NO)
   - A concrete goal has a testable end state (e.g., "tests pass", "endpoint returns 200", "file exists with schema X").
   - A vague goal lacks a verifiable condition (e.g., "improve performance", "make it better", "add collaboration").

2. If NOT concrete, list CLARIFICATION_QUESTIONS — the minimum set of questions whose answers would make the goal concrete.

3. If concrete, propose SUCCESS_CONDITION — a single sentence describing the verifiable end state.

Return structured findings:
CONCRETE=YES|NO
SUCCESS_CONDITION=<proposed condition if concrete>
CLARIFICATION_QUESTIONS=<list if not concrete>`;
}

// ── Phase 2: Constraint Mapping ────────────────────────────────────

export function promptConstraintMappingComposer(): string {
  return `You have a confirmed goal and success condition. Now map the boundaries.

Spawn an Assessor with the INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT blocks.

Based on the Assessor's findings, use the RE_INVOCATION_TEMPLATE. Copy the ACCUMULATED_FLAGS as-is and append:
  --constraints-confirmed true --invariants "<assessor's invariants>" --degrees-of-freedom "<assessor's degrees>" --quality-criteria "<assessor's criteria>"`;
}

export function promptConstraintMappingInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir.

Given the GOAL, SUCCESS_CONDITION, DOMAIN, and any user-provided CONSTRAINTS, analyze the codebase and identify:

1. INVARIANTS — things that must NOT change. Examples: public API signatures, database schemas, existing test contracts, auth flows.
   Search the codebase for the relevant boundaries.

2. DEGREES_OF_FREEDOM — things that CAN change. Examples: internal implementation, new files, configuration, feature flags.

3. QUALITY_CRITERIA — what a good solution looks like. Examples: no new dependencies, backwards compatible, follows existing patterns, has tests.
   Derive these from KNOWLEDGE_CONTEXT if provided, otherwise infer from codebase conventions.

Return structured findings:
INVARIANTS=<comma-separated>
DEGREES_OF_FREEDOM=<comma-separated>
QUALITY_CRITERIA=<comma-separated>`;
}

// ── Phase 3: Strategy Discovery ────────────────────────────────────

export function promptStrategyDiscoveryComposer(): string {
  return `You have the goal, success condition, and constraint map. Now discover all possible strategies.

Spawn an Assessor with the INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT blocks.

Based on the Assessor's findings, use the RE_INVOCATION_TEMPLATE. Copy the ACCUMULATED_FLAGS as-is and append:
  --strategies-raw "<strategy1|strategy2|strategy3|...>"

Each strategy should be a short name. Use | as delimiter.`;
}

export function promptStrategyDiscoveryInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir, fetch_webpage.

Given the GOAL, SUCCESS_CONDITION, INVARIANTS, DEGREES_OF_FREEDOM, QUALITY_CRITERIA, and DOMAIN:

Generate ALL plausible strategies to achieve the goal. For each strategy:
- Name it concisely (e.g., "feature-flag-gate", "extend-state-model", "replace-state-layer")
- Describe what changes it requires (1-2 sentences)
- Note which invariants it respects and which degrees of freedom it uses

Include at least one narrow/safe approach, one moderate approach, and one wide/architectural approach.
Include a workaround strategy if applicable (something that partially achieves the goal with minimal changes).

Return structured findings:
STRATEGY_1=<name>: <description>
STRATEGY_2=<name>: <description>
...
STRATEGIES_RAW=<name1|name2|name3|...>`;
}

// ── Phase 4: Strategy Ordering ─────────────────────────────────────

export function promptStrategyOrderingComposer(): string {
  return `You have raw candidate strategies. Now order them into a safety ladder.

Spawn an Assessor with the INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT blocks.

Based on the Assessor's findings, use the RE_INVOCATION_TEMPLATE. Copy the ACCUMULATED_FLAGS as-is and append:
  --strategies-ordered "<strategy1|strategy2|strategy3|...>"

The order must go from safest/narrowest to most invasive/widest.`;
}

export function promptStrategyOrderingInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir.

Given STRATEGIES_RAW, INVARIANTS, QUALITY_CRITERIA, and DOMAIN:

Order the strategies from safest to most invasive using these criteria (in priority order):
1. SCOPE — narrow changes before wide changes
2. REVERSIBILITY — easily reversible before hard to reverse
3. RISK — low risk of breakage before high risk
4. QUALITY — clean solutions before hacky workarounds

For each strategy, assign:
- SCOPE: narrow | moderate | wide
- REVERSIBILITY: reversible | partially-reversible | irreversible
- RISK: low | medium | high
- QUALITY: clean | acceptable | hacky

Return structured findings:
ORDERING_RATIONALE=<why this order>
STRATEGIES_ORDERED=<strategy1|strategy2|strategy3|...>`;
}

// ── Phase 5: Verify Hook Definition ────────────────────────────────

export function promptVerifyHookComposer(): string {
  return `You have ordered strategies. Now define how to verify each one worked.

Spawn an Assessor with the INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT blocks.

Based on the Assessor's findings, use the RE_INVOCATION_TEMPLATE. Copy the ACCUMULATED_FLAGS as-is and append:
  --verify-hook-confirmed '[{"strategy":"<name>","verify":"<command>"}, ...]'`;
}

export function promptVerifyHookInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir.

Given STRATEGIES_ORDERED, SUCCESS_CONDITION, and DOMAIN:

For each strategy in the ordered list, define a concrete verification hook — a command or check that proves the strategy succeeded. Examples:
- "run: npm test -- --filter=auth"
- "check: file exists at src/collab/provider.ts with export CollabProvider"
- "run: curl -s localhost:3000/api/health | jq .status == 'ok'"
- "check: no TypeScript errors in src/"

The verify hook must be:
1. Automatable (runnable as a command or checkable as a file condition)
2. Deterministic (same result every time if the strategy worked)
3. Specific to the strategy (not a generic "tests pass")

Return structured findings:
VERIFY_HOOKS=[
  {"strategy": "<name>", "verify": "<command or check>"},
  ...
]`;
}

// ── Phase 6: Score Emission ────────────────────────────────────────

export function promptScoreEmissionComposer(): string {
  return `You have a complete, validated spec (or the spec has been approved by the human).

If SPEC_APPROVED is NOT set in the REVIEW_CONTEXT: present the SPEC to the human for review. This is a HUMAN GATE — you must ask the user to approve before proceeding. When they approve, use the RE_INVOCATION_TEMPLATE and append:
  --spec-approved true

If SPEC_APPROVED IS set: spawn an Executor to implement the top strategy from the spec. Then use the RE_INVOCATION_TEMPLATE and append:
  --score-generated true`;
}

export function promptScoreEmissionInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: read_file, list_dir.

If this is a spec review (SPEC_APPROVED not set):
Review the SPEC block for completeness. Verify that:
1. Every strategy has a verify hook
2. Strategies are ordered from safe to invasive
3. Success condition is verifiable
4. No invariants are violated by any strategy

Return:
SPEC_VALID=YES|NO
SPEC_ISSUES=<list of issues if NO>

If SPEC_APPROVED is set:
Confirm the spec is ready for score generation.
Return:
READY_TO_EMIT=YES`;
}

// ── Phase 7: Score Execution ───────────────────────────────────────

export function promptScoreExecutionComposer(): string {
  return `The strategy has been implemented. Now verify it works.

Present the execution plan to the human for approval. Show them:
1. The strategies that were attempted (in order)
2. The verify hooks that will be used
3. That execution will follow the standard Symphony protocol

This is a HUMAN GATE — you must ask the user to approve before proceeding.
When the human approves, use the RE_INVOCATION_TEMPLATE and append:
  --execution-approved true

If the human declines, report that execution was declined and stop.`;
}

export function promptScoreExecutionInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: read_file, list_dir, grep_search.

Review the generated score for execution readiness:
1. Verify the generated score.sh exists and follows Symphony conventions (exit codes 0/1/2, judgment() calls)
2. Verify prompts.sh has paired composer/instrument functions
3. Verify every instrument prompt declares ALLOWED TOOLS
4. Verify the strategy order matches the approved spec

Return:
EXECUTION_READY=YES|NO
EXECUTION_ISSUES=<list of issues if NO>
STRATEGIES_TO_EXECUTE=<ordered list of strategy names>`;
}
