import type { Inspected, InspectionLimits, PropValueType } from "./types.js";

const REACT_ELEMENT = Symbol.for("react.element");
const REACT_TRANSITIONAL_ELEMENT = Symbol.for("react.transitional.element");

export function isReactElement(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { $$typeof?: symbol }).$$typeof;
  return t === REACT_ELEMENT || t === REACT_TRANSITIONAL_ELEMENT;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  if (isReactElement(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function valueType(value: unknown): PropValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isReactElement(value)) return "element";
  const t = typeof value;
  if (t === "object") return "object";
  if (t === "function") return "function";
  return t as PropValueType;
}

function elementName(value: unknown): string {
  const type = (value as { type?: unknown }).type;
  if (typeof type === "string") return type;
  if (typeof type === "function") return (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name ?? "Anonymous";
  return "Element";
}

/**
 * Bounded, cycle-safe, non-retaining snapshot.
 *
 * Deliberately not `JSON.stringify`: that throws on cycles and BigInt, drops
 * `undefined`/functions/symbols, and has no size ceiling.
 */
export function inspect(value: unknown, limits: InspectionLimits): Inspected {
  const budget = { nodes: limits.maxSerializedNodes };
  try {
    return walk(value, limits, budget, limits.depth, new WeakSet<object>());
  } catch {
    return { t: "truncated", hint: "inspection failed" };
  }
}

function walk(
  value: unknown,
  limits: InspectionLimits,
  budget: { nodes: number },
  depth: number,
  seen: WeakSet<object>,
): Inspected {
  if (budget.nodes-- <= 0) return { t: "truncated", hint: "size limit" };

  if (value === undefined) return { t: "undefined" };
  if (value === null) return { t: "primitive", v: null };

  const type = typeof value;
  if (type === "number") return Number.isNaN(value) ? { t: "nan" } : { t: "primitive", v: value as number };
  if (type === "boolean") return { t: "primitive", v: value as boolean };
  if (type === "string") {
    const s = value as string;
    return {
      t: "primitive",
      v: s.length > limits.maxStringLength ? `${s.slice(0, limits.maxStringLength)}…(+${s.length - limits.maxStringLength})` : s,
    };
  }
  if (type === "symbol") return { t: "symbol", v: String(value) };
  if (type === "bigint") return { t: "bigint", v: `${String(value)}n` };
  if (type === "function") {
    const fn = value as { displayName?: string; name?: string };
    return { t: "function", name: fn.displayName ?? fn.name ?? "anonymous" };
  }

  const obj = value as object;
  if (seen.has(obj)) return { t: "circular" };
  seen.add(obj);

  if (isReactElement(obj)) return { t: "element", name: elementName(obj) };

  if (Array.isArray(obj)) {
    const length = obj.length;
    if (depth <= 0) return { t: "array", length };
    const take = Math.min(length, limits.maxArrayLength);
    const items: Inspected[] = [];
    for (let i = 0; i < take; i++) items.push(walk(obj[i], limits, budget, depth - 1, seen));
    return { t: "array", length, items, truncated: take < length };
  }

  const ctor = objectTag(obj);
  let keys: string[];
  try {
    keys = Object.keys(obj as Record<string, unknown>);
  } catch {
    return { t: "object", ctor };
  }
  if (depth <= 0) {
    return { t: "object", ctor, keys: keys.slice(0, limits.maxObjectKeys), truncated: keys.length > limits.maxObjectKeys };
  }
  const take = Math.min(keys.length, limits.maxObjectKeys);
  const entries: Record<string, Inspected> = {};
  for (let i = 0; i < take; i++) {
    const k = keys[i] as string;
    let v: unknown;
    try {
      v = (obj as Record<string, unknown>)[k];
    } catch {
      // A throwing getter must never take down the app being debugged.
      entries[k] = { t: "truncated", hint: "getter threw" };
      continue;
    }
    entries[k] = walk(v, limits, budget, depth - 1, seen);
  }
  return { t: "object", ctor, entries, truncated: take < keys.length };
}

function objectTag(obj: object): string | undefined {
  const proto = Object.getPrototypeOf(obj);
  if (proto === Object.prototype || proto === null) return undefined;
  const name = proto?.constructor?.name;
  return typeof name === "string" && name !== "Object" ? name : undefined;
}

/** Single-line rendering for console output. */
export function formatInspected(node: Inspected | undefined): string {
  if (!node) return "…";
  switch (node.t) {
    case "primitive":
      return typeof node.v === "string" ? JSON.stringify(node.v) : String(node.v);
    case "undefined":
      return "undefined";
    case "nan":
      return "NaN";
    case "symbol":
    case "bigint":
      return node.v;
    case "function":
      return `ƒ ${node.name}()`;
    case "element":
      return `<${node.name} />`;
    case "circular":
      return "[Circular]";
    case "truncated":
      return `[… ${node.hint}]`;
    case "array": {
      if (!node.items) return `Array(${node.length})`;
      const body = node.items.map(formatInspected).join(", ");
      return `[${body}${node.truncated ? ", …" : ""}]`;
    }
    case "object": {
      const prefix = node.ctor ? `${node.ctor} ` : "";
      if (node.entries) {
        const body = Object.entries(node.entries)
          .map(([k, v]) => `${k}: ${formatInspected(v)}`)
          .join(", ");
        return `${prefix}{ ${body}${node.truncated ? ", …" : ""} }`;
      }
      if (node.keys) return `${prefix}{ ${node.keys.join(", ")}${node.truncated ? ", …" : ""} }`;
      return `${prefix}{…}`;
    }
  }
}
