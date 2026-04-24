/**
 * domain.ts — Refactoring domain instance for the Symphony framework.
 *
 * Ties together: template (with dispatch on strategyResolution.confidence),
 * validator registration, and catalog loading.
 */

import type { CatalogEntry, DomainInstance, TemplateNode, ValidatorRegistry } from "../symphony-core/types";
import { refactoringCatalog } from "./catalog";
import { registerRefactoringValidators } from "./validators";

/**
 * The refactoring template — a looping model with a dispatch on
 * strategyResolution.confidence to select assessor mode.
 *
 * Linear structure:
 *   classify → dispatch(deterministic: lookup, heuristic: assessor-evaluate)
 *   → gate → LOOP_START → execute-move → verify-move → gate → LOOP_END
 *   → verify-problem
 */
export const refactoringTemplate: TemplateNode[] = [
  { type: "phase", name: "classify" },
  {
    type: "dispatch",
    on: "strategyResolution.confidence",
    branches: {
      deterministic: [{ type: "phase", name: "catalog-lookup" }],
      heuristic: [{ type: "phase", name: "assessor-evaluate" }],
    },
  },
  { type: "gate", requires: "strategy-confirmed" },
  { type: "loop_start" },
  { type: "phase", name: "execute-move" },
  { type: "phase", name: "verify-move" },
  { type: "gate", requires: "move-success" },
  { type: "loop_end" },
  { type: "phase", name: "verify-problem" },
];

export const refactoringDomain: DomainInstance = {
  name: "refactoring",
  template: refactoringTemplate,

  registerValidators(registry: ValidatorRegistry): void {
    registerRefactoringValidators(registry);
  },

  loadCatalog(): CatalogEntry[] {
    return refactoringCatalog;
  },
};
