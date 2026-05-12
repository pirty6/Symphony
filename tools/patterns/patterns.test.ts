/**
 * patterns.test.ts — Pattern registry, render, and shape invariants.
 */

import { listPatterns, getPattern } from "./index";
import { renderPatternMarkdown } from "./render";

describe("PatternLibrary", () => {
  test("getPattern returns a known pattern", () => {
    expect(getPattern("investigate")?.score.pattern).toBe("investigate");
    expect(getPattern("refactor")?.score.pattern).toBe("refactor");
    expect(getPattern("feature")?.score.pattern).toBe("feature");
    expect(getPattern("fix")?.score.pattern).toBe("fix");
  });

  test("getPattern returns undefined for unknown name", () => {
    expect(getPattern("nope")).toBeUndefined();
  });

  test("every pattern has a non-empty description and beat list", () => {
    for (const p of listPatterns()) {
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.score.beats.length).toBeGreaterThan(0);
    }
  });

  test("fix pattern has expected step sequence", () => {
    const fix = getPattern("fix");
    if (!fix) {
      throw new Error("fix pattern not found");
    }
    expect(fix.score.beats.map((b) => b.step)).toEqual([
      "reproduce",
      "diagnose",
      "fix",
      "cover",
      "regress",
      "lint",
    ]);
    expect(fix.requiredContext).toEqual(["bug", "reproduction"]);
  });

  test("beat steps are unique within each pattern", () => {
    for (const p of listPatterns()) {
      const steps = p.score.beats.map((b) => b.step);
      expect(new Set(steps).size).toBe(steps.length);
    }
  });
});

describe("renderPatternMarkdown", () => {
  test("emits frontmatter, heading, beats, and annotation table", () => {
    const investigate = getPattern("investigate");
    if (!investigate) {
      throw new Error("investigate pattern not found");
    }
    const md = renderPatternMarkdown(investigate);
    expect(md).toContain("pattern: investigate");
    expect(md).toContain("description:");
    expect(md).toContain("# investigate");
    expect(md).toContain("## Beats");
    expect(md).toContain("## Annotation table");
    expect(md).toContain("| Step | Level | Instrument |");
  });

  test("renders all beats in declaration order", () => {
    const pattern = getPattern("refactor");
    if (!pattern) {
      throw new Error("refactor pattern not found");
    }
    const md = renderPatternMarkdown(pattern);
    let lastIndex = -1;
    for (const beat of pattern.score.beats) {
      const idx = md.indexOf(`**${beat.step}**`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  test("notes (none) when requiredContext is empty", () => {
    const investigate = getPattern("investigate");
    if (!investigate) {
      throw new Error("investigate pattern not found");
    }
    const md = renderPatternMarkdown(investigate);
    expect(md).toMatch(/Required context\s*\n\s*\n\(none\)/);
  });

  test("lists requiredContext keys when present", () => {
    const refactor = getPattern("refactor");
    if (!refactor) {
      throw new Error("refactor pattern not found");
    }
    const md = renderPatternMarkdown(refactor);
    expect(md).toContain("`target`");
    expect(md).toContain("`invariant`");
  });
});
