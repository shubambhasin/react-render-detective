import { describe, expect, it } from "vitest";
import { assertNoRenderRegressions, compareProfiles } from "../src/testing/index.js";
import type { RenderProfile } from "../src/testing/index.js";

const profile = (components: RenderProfile["components"]): RenderProfile => ({ scenario: "type in search", components });

describe("render regression gate", () => {
  it("fails a pull request that makes a component render more", () => {
    const before = profile({ ProductTable: { renders: 2, remounts: 0, avoidableRenders: 0 } });
    const after = profile({ ProductTable: { renders: 20, remounts: 0, avoidableRenders: 18 } });

    const result = compareProfiles(before, after);
    expect(result.ok).toBe(false);
    expect(result.regressions.map((r) => r.metric)).toEqual(["renders", "avoidableRenders"]);
    expect(result.message).toContain("ProductTable  renders: 2 → 20");
    expect(() => assertNoRenderRegressions(before, after)).toThrow(/Render regressions/);
  });

  it("catches a component that starts remounting", () => {
    const before = profile({ Row: { renders: 4, remounts: 0, avoidableRenders: 0 } });
    const after = profile({ Row: { renders: 4, remounts: 12, avoidableRenders: 0 } });
    const result = compareProfiles(before, after);
    expect(result.regressions[0]?.metric).toBe("remounts");
  });

  it("passes unchanged behaviour, and tolerates noise when asked", () => {
    const before = profile({ Row: { renders: 10, remounts: 0, avoidableRenders: 0 } });
    expect(compareProfiles(before, before).ok).toBe(true);

    const noisy = profile({ Row: { renders: 11, remounts: 0, avoidableRenders: 0 } });
    expect(compareProfiles(before, noisy).ok).toBe(false);
    expect(compareProfiles(before, noisy, { tolerance: 0.2 }).ok).toBe(true);
  });

  it("reports improvements without failing, and nudges to re-baseline", () => {
    const before = profile({ Row: { renders: 40, remounts: 0, avoidableRenders: 40 } });
    const after = profile({ Row: { renders: 4, remounts: 0, avoidableRenders: 0 } });
    const result = compareProfiles(before, after);
    expect(result.ok).toBe(true);
    expect(result.improvements.length).toBeGreaterThan(0);
    expect(result.message).toContain("update the baseline");
    expect(compareProfiles(before, after, { failOnImprovement: true }).ok).toBe(false);
  });

  it("does not fail on components missing from the baseline, but names them", () => {
    const before = profile({ Row: { renders: 2, remounts: 0, avoidableRenders: 0 } });
    const after = profile({
      Row: { renders: 2, remounts: 0, avoidableRenders: 0 },
      NewThing: { renders: 9, remounts: 0, avoidableRenders: 9 },
    });
    const result = compareProfiles(before, after);
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(["NewThing"]);
    expect(result.message).toContain("New components not in the baseline: NewThing");
  });

  it("honours ignore lists and noise floors", () => {
    const before = profile({ Icon: { renders: 1, remounts: 0, avoidableRenders: 0 } });
    const after = profile({ Icon: { renders: 3, remounts: 0, avoidableRenders: 0 } });
    expect(compareProfiles(before, after, { ignore: ["Icon"] }).ok).toBe(true);
    expect(compareProfiles(before, after, { ignoreBelow: 5 }).ok).toBe(true);
  });
});
