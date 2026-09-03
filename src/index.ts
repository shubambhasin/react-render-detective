import { attachConsoleReporter } from "./console/reporter.js";
import { explainEvents, formatExplanation } from "./core/explain.js";
import { getDetective } from "./core/store.js";
import type {
  AppStats,
  ComponentStats,
  DetectiveConfig,
  DetectiveOptions,
  RenderEvent,
} from "./core/types.js";

const REPORTER = Symbol.for("react-render-detective.reporter");
type Global = typeof globalThis & { [REPORTER]?: () => void };

/**
 * Enable diagnostics. Safe to call repeatedly — Fast Refresh, duplicate module
 * copies and re-entrant setup all reconfigure the single instance rather than
 * stacking listeners (§47).
 */
export function init(options: DetectiveOptions = {}): void {
  const detective = getDetective();
  detective.init(options);

  const g = globalThis as Global;
  g[REPORTER]?.();
  g[REPORTER] = undefined;

  if (detective.enabled && detective.config.mode !== "silent") {
    g[REPORTER] = attachConsoleReporter(detective);
  } else if (!detective.enabled) {
    // Never fail silently: a disabled detective looks identical to a broken one.
    console.info(
      "[RRD] Diagnostics are disabled" +
        (detective.config.enabled === false ? " (enabled: false, or a production build was detected)." : "."),
    );
  }
}

/** Update configuration without re-initialising. */
export function configure(options: DetectiveOptions): void {
  getDetective().configure(options);
}

export function getConfig(): Readonly<DetectiveConfig> {
  return getDetective().config;
}

export function isEnabled(): boolean {
  return getDetective().enabled;
}

/** Oldest → newest, bounded by `maxEvents`. */
export function getEvents(): RenderEvent[] {
  return getDetective().getEvents();
}

export function getStats(): AppStats {
  return getDetective().getStats();
}

export function getComponentStats(name?: string): ComponentStats[] {
  return getDetective().getComponentStats(name);
}

/** Live event stream. Returns an unsubscribe function. */
export function subscribe(listener: (event: RenderEvent) => void): () => void {
  return getDetective().subscribe(listener);
}

/** Clears recorded events and statistics; instrumentation stays attached. */
export function clear(): void {
  getDetective().clear();
}

/** Full teardown, including configuration. Mainly for tests and HMR disposal. */
export function reset(): void {
  const g = globalThis as Global;
  g[REPORTER]?.();
  g[REPORTER] = undefined;
  getDetective().reset();
}

/**
 * The flagship answer: aggregate every recorded render of one component into a
 * single, human explanation. Returns `undefined` if nothing was recorded.
 */
export function explain(componentName: string): string | undefined {
  const explanation = explainStructured(componentName);
  return explanation ? formatExplanation(explanation) : undefined;
}

/** Structured form of `explain`, for building UIs on top. */
export function explainStructured(componentName: string) {
  return explainEvents(componentName, getEvents(), getDetective().lifecycleOf(componentName));
}

/** Prints the application-level dashboard (§53). */
export function printStats(): void {
  const s = getStats();
  const lines = [
    "React Render Detective",
    "",
    `Components               ${s.components}`,
    `Total renders            ${s.totalRenders}`,
    `Total render time        ${s.totalRenderTime.toFixed(1)}ms`,
    `Slow renders             ${s.slowRenders}`,
    `Potentially avoidable    ${s.potentiallyAvoidableRenders}`,
  ];
  const rebuilt = s.mostRendered.filter((c) => c.remountCount >= 2);
  if (rebuilt.length > 0) {
    lines.push(
      "",
      "Rebuilt rather than re-rendered (state and DOM discarded each time)",
      ...rebuilt.slice(0, 5).map((c) => `  ${c.name.padEnd(22)} ${String(c.remountCount).padStart(5)}× remounted`),
    );
  }
  if (s.devReplays > 0) {
    lines.push(`Development replays      ${s.devReplays} (StrictMode / discarded — not counted above)`);
  }
  if (s.mostExpensive.length > 0) {
    lines.push("", "Top by cumulative render time");
    for (const [i, c] of s.mostExpensive.slice(0, 5).entries()) {
      lines.push(
        `${String(i + 1).padStart(2)}. ${c.name.padEnd(22)} ${String(c.renderCount).padStart(6)} renders  ${c.totalSelfDuration
          .toFixed(1)
          .padStart(8)}ms  (avg ${c.averageSelfDuration.toFixed(1)}ms, p95 ${c.p95SelfDuration.toFixed(1)}ms)`,
      );
    }
  }
  console.log(lines.join("\n"));
}

/** Namespaced form, matching the documented `ReactRenderDetective.init()` usage. */
export const ReactRenderDetective = {
  init,
  configure,
  getConfig,
  isEnabled,
  getEvents,
  getStats,
  getComponentStats,
  subscribe,
  clear,
  reset,
  explain,
  explainStructured,
  printStats,
};

export { withRenderDetective } from "./react/withRenderDetective.js";
export { RenderDetective } from "./react/RenderDetective.js";
export type { RenderDetectiveProps } from "./react/RenderDetective.js";
export {
  useRenderDiagnostics,
  useTrackedState,
  useTrackedEffect,
  useTrackedContextValue,
} from "./react/hooks.js";
export type { TrackOptions } from "./react/instrument.js";
export { explainEvents, formatExplanation } from "./core/explain.js";
export type { Explanation } from "./core/explain.js";
export type * from "./core/types.js";
