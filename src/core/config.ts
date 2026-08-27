import type { DetectiveConfig, DetectiveOptions } from "./types.js";

declare const process: { env?: Record<string, string | undefined> } | undefined;

/**
 * Best-effort dev detection. No bundler-specific globals are referenced in the
 * core (`import.meta.env` is Vite-only), so this works everywhere and defaults
 * to **off** when it cannot tell — production safety over convenience (§29).
 */
export function detectDev(): boolean {
  try {
    const env = typeof process !== "undefined" ? process?.env : undefined;
    if (env && env.NODE_ENV) return env.NODE_ENV !== "production";
  } catch {
    /* ignore */
  }
  return false;
}

export const defaultConfig: DetectiveConfig = {
  enabled: detectDev(),
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
