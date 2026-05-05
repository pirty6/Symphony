---
default-complexity: 3
verb-triggers: [build, create, add, implement, introduce, ship, develop]
---

# Feature Algorithm

The canonical algorithm for adding a new capability to an existing system.

## Steps

1. Define scope — state the feature's inputs, outputs, and boundary in one paragraph.
2. Survey neighbors — locate the modules, types, and conventions the feature will touch.
3. Specify contract — write the public signature, data shapes, error modes, AND known edge cases before any code.
4. Test contract and known edges — write tests for each named behavior and each known edge case. Tests must fail until implementation lands.
5. Sketch design — choose the internal structure and name the components that will implement the contract.
6. Implement core — write the primary code path until the contract tests pass.
7. Cover discovered edges — handle edge cases that surfaced during implementation; add a test for each before fixing.
8. Verify integration — run the full suite and confirm the feature composes with existing code.

## Notes for the iteration

- Steps 1, 3, and 4 form the load-bearing trio: scope → contract+known-edges → tests-as-contract.
- The split between "known edges" (step 4) and "discovered edges" (step 7) is intentional. Known edges go first because you can foresee them. Discovered edges still get tested first — but later, when they appear.
- Wrong template signals: fixing existing behavior → bug-fix. Reshaping module boundaries → refactor.
- Resist merging steps 6 and 7 — splitting them keeps edge work from being silently absorbed into implementation churn.
- "I don't know the edge cases yet" is a signal step 3 isn't finished. Push back to step 3.
- "Drop survey neighbors, I know the codebase" allowed only if the user cited the relevant files.
- "Skip the contract tests, I'll write tests after" — push back. The whole shape assumes tests precede code.

## Annotation

| Step      | Level | Instrument  | Why                                                                 |
|-----------|-------|-------------|---------------------------------------------------------------------|
| define    | 4     | brass       | Declares the system contract the feature commits to.                |
| survey    | 3     | woodwinds   | Exploratory mapping of module behavior the feature will touch.      |
| specify   | 4     | strings     | Relates the new contract — including edges — to existing types.     |
| test      | 4     | brass       | Asserts contract and known edges executably.                        |
| sketch    | 5     | piano       | Integrative architectural choice across the new components.         |
| implement | 2     | percussion  | Ordered local construction of the primary code path.                |
| cover     | 2     | brass       | Assertive handling of discovered edges, test-first.                 |
| verify    | 4     | piano       | Integrates the feature into the system contract end-to-end.         |
