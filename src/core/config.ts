import type { DetectiveConfig, DetectiveOptions } from "./types.js";

declare const process: { env?: Record<string, string | undefined> } | undefined;

/**
 * Positive production detection.
 *
 * Deliberately asymmetric: this returns `true` only when it can actually *see*
 * `NODE_ENV === "production"`. Anything else — including environments where
 * `process` does not exist at all, such as a Vite dev server in the browser —
 * is "not known to be production".
 *
 * The earlier version asked the opposite question ("is this dev?") and answered
 * `false` when it could not tell, which meant the documented Vite quick-start
 * turned the tool on and then silently recorded nothing.
 */
export function detectProduction(): boolean {
  try {
    const env = typeof process !== "undefined" ? process?.env : undefined;
    if (env && env.NODE_ENV) return env.NODE_ENV === "production";
  } catch {
    /* ignore */
  }
  return false;
}

/** @deprecated Use `detectProduction()`. Kept so existing imports keep working. */
export function detectDev(): boolean {
  return !detectProduction();
}

export const defaultConfig: DetectiveConfig = {
  // Off until `init()` is called, so importing the package costs nothing.
  enabled: false,
  mode: "console",
  include: [],
  exclude: [],
  samplingRate: 1,
  maxEvents: 1000,
  slowRenderThreshold: 16,
  thresholds: { monitor: 5, slow: 16, verySlow: 50, critical: 100 },
  inspection: {
    depth: 1,
    maxObjectKeys: 20,
    maxArrayLength: 20,
    maxStringLength: 120,
    maxSerializedNodes: 200,
  },
  compareFunctionSource: false,
};

export function mergeConfig(base: DetectiveConfig, options: DetectiveOptions = {}): DetectiveConfig {
  const { thresholds, inspection, ...rest } = options;
  const next: DetectiveConfig = {
    ...base,
    ...(rest as Partial<DetectiveConfig>),
    thresholds: { ...base.thresholds, ...thresholds },
    inspection: { ...base.inspection, ...inspection },
  };
  next.samplingRate = clamp(next.samplingRate, 0, 1);
  next.maxEvents = Math.max(1, Math.floor(next.maxEvents));
  next.inspection.depth = clamp(Math.floor(next.inspection.depth), 0, 6);
  return next;
}

function clamp(n: number, lo: number, hi: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function matches(name: string, patterns: Array<string | RegExp>): boolean {
  for (const p of patterns) {
    if (typeof p === "string" ? p === name : p.test(name)) return true;
  }
  return false;
}

/** Filter policy: exclude wins over include; empty include means "everything". */
export function shouldInstrument(name: string, config: DetectiveConfig): boolean {
  if (matches(name, config.exclude)) return false;
  if (config.include.length > 0 && !matches(name, config.include)) return false;
  return true;
}
