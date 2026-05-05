/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["."],
  testMatch: ["**/*.test.ts"],
  // ts-jest emits TS151002 because the workspace tsconfig uses
  // module=Node16. Tests don't need module-graph fidelity; isolated
  // modules silences the warning without affecting the typecheck pass.
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        isolatedModules: true,
      },
    ],
  },
};
