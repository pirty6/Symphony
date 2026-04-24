/**
 * errors.ts — Framework error hierarchy.
 *
 * Every failure mode has a named type with a `tier` field indicating
 * which testing tier would have caught it. Errors shift left:
 * compile-time > runtime > eval-time.
 */

export abstract class FrameworkError extends Error {
  abstract readonly tier: "compile" | "runtime";

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// ── Compile-time errors (caught by interpreter before execution) ───

export class SchemaError extends FrameworkError {
  readonly tier = "compile" as const;

  constructor(message: string) {
    super(message);
  }
}

export class DispatchError extends FrameworkError {
  readonly tier = "compile" as const;

  constructor(
    readonly dispatchOn: string,
    readonly resolvedValue: string,
    readonly availableBranches: string[],
  ) {
    super(
      `No branch for ${dispatchOn}=${resolvedValue}. Available: ${availableBranches.join(", ")}`,
    );
  }
}

export class LifecycleError extends FrameworkError {
  readonly tier = "compile" as const;

  constructor(
    readonly method: string,
    readonly requiredState: string,
    readonly actualState: string,
  ) {
    super(
      `${method} called in wrong state: requires ${requiredState}, was ${actualState}`,
    );
  }
}

// ── Runtime errors (caught by Composer during execution) ───────────

export class VerdictValidationError extends FrameworkError {
  readonly tier = "runtime" as const;

  constructor(
    readonly field: string,
    readonly expected: string,
    readonly received: unknown,
    readonly moveType: string,
  ) {
    super(
      `Invalid verdict field '${field}' for ${moveType}: expected ${expected}, got ${JSON.stringify(received)}`,
    );
  }
}

export class ProgressStallError extends FrameworkError {
  readonly tier = "runtime" as const;

  constructor(
    readonly moveType: string,
    readonly targetSite: string,
    readonly stateHash: string,
    readonly iteration: number,
  ) {
    super(
      `Stall: ${moveType}@${targetSite} repeated at hash ${stateHash}, iteration ${iteration}`,
    );
  }
}
