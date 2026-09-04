/**
 * Render-regression testing.
 *
 * Fixing a render problem once is easy; keeping it fixed is the hard part. This
 * turns render behaviour into something a pull request can fail on: record a
 * profile for a scripted interaction, commit it, and compare on every run.
 *
 * Deliberately assertion-library agnostic — it returns data and a message, and
 * your test framework decides what to do with it.
 */
import type { RenderEvent } from "../core/types.js";

export interface ComponentProfile {
  renders: number;
  remounts: number;
  avoidableRenders: number;
}

export interface RenderProfile {
  /** Free-form label, e.g. "search: type one character". */
  scenario: string;
  components: Record<string, ComponentProfile>;
}

export interface RegressionOptions {
  /**
   * Allowed growth before a component counts as regressed, as a fraction.
   * `0.2` tolerates a 20% increase. Defaults to 0 — exact.
   */
  tolerance?: number;
  /** Ignore components below this render count in the baseline. */
  ignoreBelow?: number;
  /** Component names to skip entirely. */
  ignore?: string[];
  /** Fail when a component is rendering *fewer* times too. Off by default. */
  failOnImprovement?: boolean;
}

export interface Regression {
  component: string;
  metric: "renders" | "remounts" | "avoidableRenders";
  baseline: number;
  current: number;
  delta: number;
}

export interface RegressionResult {
  ok: boolean;
  scenario: string;
  regressions: Regression[];
  improvements: Regression[];
  /** Components present now but absent from the baseline. */
  added: string[];
  message: string;
}

/** Builds a profile from recorded events. Pass `getEvents()`. */
export function profileFromEvents(scenario: string, events: RenderEvent[], remounts: Record<string, number> = {}): RenderProfile {
  const components: Record<string, ComponentProfile> = {};
  for (const event of events) {
    const name = event.component.name;
    const entry = (components[name] ??= { renders: 0, remounts: remounts[name] ?? 0, avoidableRenders: 0 });
    entry.renders++;
    if (event.diagnosis.potentiallyAvoidable) entry.avoidableRenders++;
  }
  return { scenario, components };
}

const METRICS: Array<Regression["metric"]> = ["renders", "remounts", "avoidableRenders"];

export function compareProfiles(
  baseline: RenderProfile,
  current: RenderProfile,
  options: RegressionOptions = {},
): RegressionResult {
  const { tolerance = 0, ignoreBelow = 0, ignore = [], failOnImprovement = false } = options;
  const regressions: Regression[] = [];
  const improvements: Regression[] = [];
  const added: string[] = [];

  for (const [component, currentProfile] of Object.entries(current.components)) {
    if (ignore.includes(component)) continue;
    const baseProfile = baseline.components[component];
    if (!baseProfile) {
      added.push(component);
      continue;
    }

    for (const metric of METRICS) {
      const before = baseProfile[metric];
      const after = currentProfile[metric];
      if (before < ignoreBelow && after < ignoreBelow) continue;
      const allowed = before + Math.max(before * tolerance, 0);
      if (after > allowed) {
        regressions.push({ component, metric, baseline: before, current: after, delta: after - before });
      } else if (after < before) {
        improvements.push({ component, metric, baseline: before, current: after, delta: after - before });
      }
    }
  }

  const ok = regressions.length === 0 && (!failOnImprovement || improvements.length === 0);
  return { ok, scenario: current.scenario, regressions, improvements, added, message: describe(current.scenario, regressions, improvements, added) };
}

function describe(scenario: string, regressions: Regression[], improvements: Regression[], added: string[]): string {
  if (regressions.length === 0) {
    const parts = [`No render regressions in "${scenario}".`];
    if (improvements.length > 0) {
      parts.push(
        `Improved: ${improvements.map((i) => `${i.component} ${i.metric} ${i.baseline}→${i.current}`).join(", ")}.`,
        "If these are intended, update the baseline so they cannot silently regress again.",
      );
    }
    if (added.length > 0) parts.push(`New components not in the baseline: ${added.join(", ")}.`);
    return parts.join("\n");
  }

  const lines = [`Render regressions in "${scenario}":`, ""];
  for (const r of regressions) {
    lines.push(`  ${r.component}  ${r.metric}: ${r.baseline} → ${r.current}  (+${r.delta})`);
  }
  lines.push(
    "",
    "Each of these is a component doing more work than the baseline allows.",
    "Run the scenario with the overlay or `explain()` to see which prop or parent is responsible,",
    "or update the baseline if the change is intended.",
  );
  return lines.join("\n");
}

/**
 * Throws when the current profile is worse than the baseline. The one-liner for
 * a test file; use `compareProfiles` when you want the data.
 */
export function assertNoRenderRegressions(
  baseline: RenderProfile,
  current: RenderProfile,
  options?: RegressionOptions,
): void {
  const result = compareProfiles(baseline, current, options);
  if (!result.ok) throw new Error(result.message);
}
