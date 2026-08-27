import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { formatInspected, inspect, valueType } from "../src/core/inspect.js";

const limits = defaultConfig.inspection;

describe("inspect", () => {
  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = inspect(a, { ...limits, depth: 3 });
    expect(formatInspected(out)).toContain("[Circular]");
  });

  it("represents NaN, undefined, null and BigInt distinctly", () => {
    expect(inspect(NaN, limits)).toEqual({ t: "nan" });
    expect(inspect(undefined, limits)).toEqual({ t: "undefined" });
    expect(inspect(null, limits)).toEqual({ t: "primitive", v: null });
    expect(inspect(10n, limits)).toEqual({ t: "bigint", v: "10n" });
  });

  it("truncates long strings, wide objects and long arrays", () => {
    const long = "x".repeat(500);
    expect(formatInspected(inspect(long, limits))).toContain("+380");

    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i++) wide[`k${i}`] = i;
    const o = inspect(wide, limits) as { truncated?: boolean };
    expect(o.truncated).toBe(true);

    const arr = inspect(Array.from({ length: 100 }, (_, i) => i), limits) as {
      length: number;
      items?: unknown[];
    };
    expect(arr.length).toBe(100);
    expect(arr.items).toHaveLength(20);
  });

  it("stops at the configured depth", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const shallow = inspect(deep, { ...limits, depth: 1 });
    expect(shallow.t === "object" && shallow.entries?.a?.t).toBe("object");
    expect(formatInspected(shallow)).toBe("{ a: { b } }");
  });

  it("survives a throwing getter", () => {
    const obj = {
      get boom(): number {
        throw new Error("nope");
      },
      ok: 1,
    };
    expect(() => inspect(obj, limits)).not.toThrow();
    expect(formatInspected(inspect(obj, limits))).toContain("getter threw");
  });

  it("does not retain the original object", () => {
    const source = { big: new Array(1000).fill("x") };
    const snapshot = inspect(source, limits) as { entries?: Record<string, unknown> };
    expect(snapshot.entries?.big).not.toBe(source.big);
  });

  it("classifies value types", () => {
    expect(valueType([])).toBe("array");
    expect(valueType(() => {})).toBe("function");
    expect(valueType(null)).toBe("null");
    expect(valueType(Symbol("s"))).toBe("symbol");
  });
});
