/**
 * validators.ts — Target site validators for the refactoring domain.
 *
 * Each validator checks format conformance, not existence.
 * Registered with the framework's ValidatorRegistry at initialization.
 */

import type { TargetSiteValidator, ValidatorRegistry } from "../symphony-core/types";

export type RefactoringTargetSiteSchema =
  | "ast-node"
  | "symbol-fqn"
  | "file-line-range"
  | "class-pair";

/**
 * ast-node: file:nodeType:identifier
 * Example: "src/utils.ts:FunctionDeclaration:processData"
 */
export const isAstNode: TargetSiteValidator = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parts = value.split(":");
  return parts.length >= 3 && parts[0].length > 0 && parts[1].length > 0 && parts[2].length > 0;
};

/**
 * symbol-fqn: dot-separated identifier path
 * Example: "OrderService.processOrder"
 */
export const isSymbolFqn: TargetSiteValidator = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0) return false;
  return /^[a-zA-Z_$]\w*(\.[a-zA-Z_$]\w*)*$/.test(value);
};

/**
 * file-line-range: file:startLine-endLine (start <= end)
 * Example: "src/utils.ts:10-25"
 */
export const isFileLineRange: TargetSiteValidator = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = value.match(/^(.+):(\d+)-(\d+)$/);
  if (!match) return false;
  return match[1].length > 0 && Number(match[2]) <= Number(match[3]);
};

/**
 * class-pair: SourceClass->TargetClass
 * Example: "OrderProcessor->OrderValidator"
 */
export const isClassPair: TargetSiteValidator = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parts = value.split("->");
  return parts.length === 2 && parts[0].trim().length > 0 && parts[1].trim().length > 0;
};

/**
 * Registers all refactoring target site validators with the framework registry.
 */
export function registerRefactoringValidators(registry: ValidatorRegistry): void {
  registry.register("ast-node", isAstNode);
  registry.register("symbol-fqn", isSymbolFqn);
  registry.register("file-line-range", isFileLineRange);
  registry.register("class-pair", isClassPair);
}
