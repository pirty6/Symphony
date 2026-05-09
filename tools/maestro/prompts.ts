/**
 * prompts.ts — Per-pause prompt strings emitted on stdout by
 * utils.ts emitPauseAndExit. Pure builders; no engine state, no fs.
 *
 * Token budget: keep terse. The JSON envelope already carries `kind`,
 * `pauseId`, and `payload`; the prompt must not restate them — only
 * direct what the agent must DO and the reply shape.
 */

import type { Beat } from "../symphony/types";
import { MAESTRO_DRAFT_MAX_ROUNDS, MAESTRO_GO_PHRASES } from "./engine";
import type { Pause } from "./types/pause";
import type { Complexity } from "./types/types";

// ── Per-pause builders ─────────────────────────────────────────────

export function composerPromptFor(pause: Pause): string {
  switch (pause.kind) {
    case "confirm-fit":
      return confirmComposer(pause.payload.pattern);
    case "classify-complexity":
      return classifyComposer();
    case "draft-pattern-round":
      return draftComposer(
        pause.payload.round,
        pause.payload.complexity,
        pause.payload.priorDraft !== undefined,
      );
    case "elicit-context":
      return elicitComposer(pause.payload.missingKeys);
    case "go-gate":
      return goGateComposer();
    case "perform-beat":
      return performComposer(pause.payload.beatIndex, pause.payload.beat);
  }
}

export function instrumentPromptFor(pause: Pause): string {
  switch (pause.kind) {
    case "confirm-fit":
      return `Confirm pattern '${pause.payload.pattern}' or reroute.`;
    case "classify-complexity":
      return "Reply 1|2|3|4 (lowest tier covering the risk).";
    case "draft-pattern-round":
      return `Round ${pause.payload.round}/${MAESTRO_DRAFT_MAX_ROUNDS}, complexity ${pause.payload.complexity}. Run debate, return draft Pattern.`;
    case "elicit-context":
      return `Provide non-empty values for: ${pause.payload.missingKeys.join(", ")}.`;
    case "go-gate":
      return `Send a canonical go phrase: ${MAESTRO_GO_PHRASES.join(", ")}.`;
    case "perform-beat":
      return `Beat ${pause.payload.beatIndex} (${pause.payload.beat.voices.map((v) => v.instrument).join("+")}): ${pause.payload.beat.directive}`;
  }
}

// ── Builders ───────────────────────────────────────────────────────

function confirmComposer(pattern: string): string {
  return `Confirm pattern '${pattern}' fits in one sentence. If not, reply ok=false with reroute=<pattern>.\nReply: { kind: 'confirm-fit', ok: boolean, reroute?: string }`;
}

function classifyComposer(): string {
  return [
    "Classify prompt complexity for draft-pattern debate (lowest tier that covers the risk):",
    "  1 trivial · 2 standard (+skeptic) · 3 high (+pragmatist) · 4 novel (+template-critic)",
    "Reply: { kind: 'classify-complexity', complexity: 1|2|3|4 }",
  ].join("\n");
}

function draftComposer(round: number, complexity: Complexity, hasPriorDraft: boolean): string {
  const agents = ["proposer"];
  if (complexity >= 2) {
    agents.push("skeptic");
  }
  if (complexity >= 3) {
    agents.push("pragmatist");
  }
  if (complexity >= 4) {
    agents.push("template-critic");
  }
  return [
    `Draft round ${round}/${MAESTRO_DRAFT_MAX_ROUNDS}, complexity ${complexity}. Spawn: ${agents.join(", ")}.`,
    hasPriorDraft ? "Iterate on priorDraft (in payload)." : "Propose from scratch.",
    "Synthesize a Pattern TS module; show user code + brief notes (framing, disagreement, open risks, what was cut). Then ask: save as tools/patterns/<name>.ts or change?",
    "Reply: { kind: 'draft-pattern-round', outcome: 'approve'|'edit'|'ambiguous', nextDraft? }",
  ].join("\n");
}

function elicitComposer(missing: readonly string[]): string {
  return [
    `Missing required context: ${missing.join(", ")}.`,
    "For each: extract from prompt (state extraction) or ask one targeted question. Empty/whitespace rejected.",
    "Reply: { kind: 'elicit-context', values: { <key>: <value>, ... } }",
  ].join("\n");
}

function goGateComposer(): string {
  return `Ask user for explicit go. Accepted (case-insensitive): ${MAESTRO_GO_PHRASES.join(", ")}. Vague positives ('yeah', 'fine-ish') rejected.\nReply: { kind: 'go-gate', phrase: '<user phrase>' }`;
}

// Per-instrument budget guidance. Soft defaults surfaced at perform-beat
// time; not enforced by the engine. Unknown instruments produce no line.
const INSTRUMENT_BUDGETS: Record<string, string> = {
  analyze: "Budget guidance: ≤ 8 file reads, ≤ 3 grep calls (soft default, not a hard limit).",
  order: "Budget guidance: ≤ 5 file edits per beat (soft default, not a hard limit).",
  integrate: "Budget guidance: ≤ 25k tokens of evidence cited (soft default, not a hard limit).",
  question: "Budget guidance: ≤ 6 sub-agent or tool calls (soft default, not a hard limit).",
  decide: "Budget guidance: ≤ 6 sub-agent or tool calls (soft default, not a hard limit).",
};

function performComposer(beatIndex: number, beat: Beat): string {
  const lines = [
    `Beat ${beatIndex} (L${beat.level}, ${beat.voices.map((v) => v.instrument).join("+")}): ${beat.directive}`,
    "Read-only → spawn maestro-assessor. Mutating → spawn maestro-executor.",
    "Reply: { kind: 'perform-beat', voiceOutputs: [...], verdict: {...} }",
    "Voice: { instrument, output, confidence: [0,1], producedBy: 'maestro-assessor'|'maestro-executor' }.",
    "Verdict: { outcome: 'applied'|'failed'|'skipped', confidence, reason, shouldTerminate }.",
  ];
  for (const v of beat.voices) {
    const hint = INSTRUMENT_BUDGETS[v.instrument];
    if (hint) {
      lines.push(`${v.instrument}: ${hint}`);
    }
  }
  return lines.join("\n");
}
