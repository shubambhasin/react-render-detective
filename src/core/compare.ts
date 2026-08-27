import { inspect, isPlainObject, isReactElement, valueType } from "./inspect.js";
import type { DetectiveConfig, Inspected, PropChange } from "./types.js";

export interface PropsDiff {
  changed: PropChange[];
  unchanged: string[];
}

/** Result of a bounded contents comparison. `undefined` = could not determine. */
type ShallowResult = boolean | undefined;

const EMPTY: Record<string, unknown> = {};

export function diffProps(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined,
  config: DetectiveConfig,
): PropsDiff {
  const prev = previous ?? EMPTY;
  const next = current ?? EMPTY;
  const changed: PropChange[] = [];
  const unchanged: string[] = [];

  const keys = new Set<string>();
  for (const k in prev) keys.add(k);
  for (const k in next) keys.add(k);

  for (const key of keys) {
    const hadPrev = key in prev;
    const hasNext = key in next;
    const a = prev[key];
    const b = next[key];

    if (hadPrev && hasNext && Object.is(a, b)) {
      unchanged.push(key);
      continue;
    }
    if (!hadPrev) {
      changed.push({ key, kind: "added", valueType: valueType(b), current: snap(b, config) });
      continue;
    }
    if (!hasNext) {
      changed.push({ key, kind: "removed", valueType: valueType(a), previous: snap(a, config) });
      continue;
    }
    changed.push(describeChange(key, a, b, config));
  }

  return { changed, unchanged };
}

function describeChange(key: string, a: unknown, b: unknown, config: DetectiveConfig): PropChange {
  const type = valueType(b);
  const base: PropChange = {
    key,
    kind: "value",
    valueType: type,
    previous: snap(a, config),
    current: snap(b, config),
  };

  if (typeof a === "function" && typeof b === "function") {
    base.kind = "reference";
    if (config.compareFunctionSource) {
      base.sourceEqual = safeSource(a) === safeSource(b);
    }
    return base;
  }

  const shallow = shallowEqual(a, b, config);
  if (shallow === true) {
    base.kind = "reference";
    base.shallowEqual = true;
  } else if (shallow === false) {
    base.kind = "value";
    base.shallowEqual = false;
  }
  return base;
}

/**
 * Bounded shallow comparison. Returns `undefined` rather than guessing when the
 * values are too large or of a shape we cannot compare cheaply — the diagnostic
 * engine treats that as "unknown", never as "equal".
 */
export function shallowEqual(a: unknown, b: unknown, config: DetectiveConfig): ShallowResult {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  const { maxObjectKeys, maxArrayLength } = config.inspection;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    if (a.length > maxArrayLength) return undefined;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : false;
  }

  if (isReactElement(a) && isReactElement(b)) {
    const ea = a as { type: unknown; key: unknown; props: unknown };
    const eb = b as { type: unknown; key: unknown; props: unknown };
    if (ea.type !== eb.type || ea.key !== eb.key) return false;
    return shallowEqual(ea.props, eb.props, config);
  }

  if (!isPlainObject(a) || !isPlainObject(b)) return undefined;

  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  if (ka.length > maxObjectKeys) return undefined;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

function snap(value: unknown, config: DetectiveConfig): Inspected {
  return inspect(value, config.inspection);
}

function safeSource(fn: unknown): string {
  try {
    return Function.prototype.toString.call(fn);
  } catch {
    return "";
  }
}
