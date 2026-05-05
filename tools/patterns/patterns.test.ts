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
  });

  test("getPattern returns undefined for unknown name", () => {
    expect(getPattern("nope")).toBeUndefined();
  });

  test("every pattern has at least one verb trigger and a non-empty beat list", () => {
    for (const p of listPatterns()) {
      expect(p.verbTriggers.length).toBeGreaterThan(0);
      expect(p.score.beats.length).toBeGreaterThan(0);
    }
  });

  test("verb triggers are unique within each pattern", () => {
    for (const p of listPatterns()) {
      expect(new Set(p.verbTriggers).size).toBe(p.verbTriggers.length);
    }
  });

  test("verb triggers do not collide across patterns", () => {
    const seen = new Map<string, string>();
    for (const p of listPatterns()) {
      for (const trigger of p.verbTriggers) {
        const prev = seen.get(trigger);
        if (prev !== undefined) {
          throw new Error(
            `verb trigger "${trigger}" appears in both ${prev} and ${p.score.pattern}`,
          );
        }
        seen.set(trigger, p.score.pattern);
      }
    }
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
    const md = renderPatternMarkdown(getPattern("investigate")!);
    expect(md).toContain("pattern: investigate");
    expect(md).toContain("verb-triggers: [");
    expect(md).toContain("# investigate");
    expect(md).toContain("## Beats");
    expect(md).toContain("## Annotation table");
    expect(md).toContain("| Step | Level | Instrument |");
  });

  test("renders all beats in declaration order", () => {
    const pattern = getPattern("refactor")!;
    const md = renderPatternMarkdown(pattern);
    let lastIndex = -1;
    for (const beat of pattern.score.beats) {
      const idx = md.indexOf(`**${beat.step}**`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  test("notes (none) when requiredContext is empty", () => {
    const md = renderPatternMarkdown(getPattern("investigate")!);
    expect(md).toMatch(/Required context\s*\n\s*\n\(none\)/);
  });

  test("lists requiredContext keys when present", () => {
    const md = renderPatternMarkdown(getPattern("refactor")!);
    expect(md).toContain("`target`");
    expect(md).toContain("`invariant`");
  });
});
