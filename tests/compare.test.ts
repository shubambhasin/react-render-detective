import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { defaultConfig } from "../src/core/config.js";
import { diffProps, shallowEqual } from "../src/core/compare.js";

const config = defaultConfig;
const diff = (a: Record<string, unknown>, b: Record<string, unknown>, c = config) => diffProps(a, b, c);
const change = (a: Record<string, unknown>, b: Record<string, unknown>, key: string) =>
  diff(a, b).changed.find((c) => c.key === key);

describe("diffProps", () => {
  it("treats identical primitives as unchanged", () => {
    const r = diff({ a: 1, b: "x", c: true }, { a: 1, b: "x", c: true });
    expect(r.changed).toEqual([]);
    expect(r.unchanged.sort()).toEqual(["a", "b", "c"]);
  });

  it("uses Object.is semantics: NaN equals NaN", () => {
    expect(diff({ n: NaN }, { n: NaN }).changed).toEqual([]);
    expect(change({ z: 0 }, { z: -0 }, "z")?.kind).toBe("value");
  });

  it("distinguishes null, undefined and missing", () => {
    expect(change({ v: null }, { v: undefined }, "v")?.kind).toBe("value");
    expect(change({}, { v: 1 }, "v")?.kind).toBe("added");
    expect(change({ v: 1 }, {}, "v")?.kind).toBe("removed");
    // present-but-undefined is not the same as absent
    expect(diff({ v: undefined }, { v: undefined }).changed).toEqual([]);
  });

  it("flags a new object with identical contents as a reference change", () => {
    const c = change({ user: { id: 42, name: "John" } }, { user: { id: 42, name: "John" } }, "user");
    expect(c?.kind).toBe("reference");
    expect(c?.shallowEqual).toBe(true);
    expect(c?.valueType).toBe("object");
  });

  it("flags genuinely different contents as a value change", () => {
    const c = change({ user: { id: 42 } }, { user: { id: 43 } }, "user");
    expect(c?.kind).toBe("value");
    expect(c?.shallowEqual).toBe(false);
  });

  it("compares arrays by identity then shallow contents", () => {
    expect(change({ xs: ["a", "b"] }, { xs: ["a", "b"] }, "xs")?.kind).toBe("reference");
    expect(change({ xs: ["a", "b"] }, { xs: ["a", "c"] }, "xs")?.kind).toBe("value");
    expect(change({ xs: [1] }, { xs: [1, 2] }, "xs")?.kind).toBe("value");
  });

  it("treats a nested object as a value change — shallow means shallow", () => {
    const c = change({ o: { deep: { x: 1 } } }, { o: { deep: { x: 1 } } }, "o");
    expect(c?.kind).toBe("value");
  });

  it("reports function props as reference changes", () => {
    const c = change({ onSave: () => {} }, { onSave: () => {} }, "onSave");
    expect(c?.kind).toBe("reference");
    expect(c?.valueType).toBe("function");
    expect(c?.sourceEqual).toBeUndefined();
  });

  it("detects recreated inline closures when source comparison is enabled", () => {
    const c = diffProps(
      { onSave: () => "hello" },
      { onSave: () => "hello" },
      { ...config, compareFunctionSource: true },
    ).changed[0];
    expect(c?.sourceEqual).toBe(true);

    const d = diffProps(
      { onSave: () => "hello" },
      { onSave: () => "goodbye" },
      { ...config, compareFunctionSource: true },
    ).changed[0];
    expect(d?.sourceEqual).toBe(false);
  });

  it("handles symbols", () => {
    const s = Symbol("k");
    expect(diff({ s }, { s }).changed).toEqual([]);
    expect(change({ s }, { s: Symbol("k") }, "s")?.kind).toBe("value");
  });

  it("compares Dates by time, not identity", () => {
    expect(change({ d: new Date(5) }, { d: new Date(5) }, "d")?.kind).toBe("reference");
    expect(change({ d: new Date(5) }, { d: new Date(6) }, "d")?.kind).toBe("value");
  });

  it("recognises equivalent React elements (children churn)", () => {
    const a = createElement("div", { className: "x" });
    const b = createElement("div", { className: "x" });
    const c = change({ children: a }, { children: b }, "children");
    expect(c?.valueType).toBe("element");
    expect(c?.kind).toBe("reference");
  });
});

describe("shallowEqual", () => {
  it("returns undefined rather than guessing on values too large to compare", () => {
    const big = (v: number) => Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, v]));
    expect(shallowEqual(big(1), big(1), config)).toBeUndefined();
  });

  it("returns undefined for class instances it cannot compare cheaply", () => {
    class Box {
      constructor(public v: number) {}
    }
    expect(shallowEqual(new Box(1), new Box(1), config)).toBeUndefined();
  });

  it("never claims equality across mismatched shapes", () => {
    expect(shallowEqual({ a: 1 }, [1], config)).toBe(false);
    expect(shallowEqual(null, {}, config)).toBe(false);
  });
});
