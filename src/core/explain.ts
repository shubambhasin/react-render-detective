import type { Confidence, RenderEvent, RenderReason } from "./types.js";

export interface Explanation {
  component: string;
  renders: number;
  /** Reason → share of renders, descending. */
  breakdown: Array<{ reason: RenderReason; count: number; share: number }>;
  /** Props that most often changed by reference only, descending. */
  unstableProps: Array<{ key: string; count: number; share: number; valueType: string }>;
  averageSelfDuration: number;
  totalSelfDuration: number;
  potentiallyAvoidableRenders: number;
  estimatedAvoidableTime: number;
  devReplays: number;
  headline: string;
  nextStep: string;
  confidence: Confidence;
}

/**
 * The flagship "explain this render" answer, aggregated across the recorded
 * history of one component. Pure — no React, no console.
 */
export function explainEvents(component: string, events: RenderEvent[]): Explanation | undefined {
  const mine = events.filter((e) => e.component.name === component);
  if (mine.length === 0) return undefined;

  const reasonCounts = new Map<RenderReason, number>();
  const unstable = new Map<string, { count: number; valueType: string }>();
  let totalSelf = 0;
  let avoidable = 0;
  let avoidableTime = 0;
  let replays = 0;

  for (const e of mine) {
    reasonCounts.set(e.diagnosis.reason, (reasonCounts.get(e.diagnosis.reason) ?? 0) + 1);
    totalSelf += e.timings.selfDuration;
    if (e.devReplay) replays++;
    if (e.diagnosis.potentiallyAvoidable) {
      avoidable++;
      avoidableTime += e.timings.selfDuration;
    }
    for (const c of e.changedProps) {
      if (c.kind !== "reference") continue;
      const entry = unstable.get(c.key) ?? { count: 0, valueType: c.valueType };
      entry.count++;
      unstable.set(c.key, entry);
    }
  }

  const breakdown = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count, share: count / mine.length }))
    .sort((a, b) => b.count - a.count);

  const unstableProps = [...unstable.entries()]
    .map(([key, v]) => ({ key, count: v.count, share: v.count / mine.length, valueType: v.valueType }))
    .sort((a, b) => b.count - a.count);

  const top = breakdown[0];
  const topProp = unstableProps[0];
  const latest = mine[mine.length - 1] as RenderEvent;

  let headline: string;
  let nextStep: string;
  let confidence: Confidence = "medium";

  if (topProp && topProp.share >= 0.5) {
    headline = `${pct(topProp.share)} of renders followed \`${topProp.key}\` changing by reference while its contents stayed the same.`;
    nextStep = `Find where \`${topProp.key}\` is created in ${latest.parent?.name ?? "the parent"} and stabilise it${
      topProp.valueType === "function" ? " (useCallback, or move it out of the component)" : " (useMemo, or pass the primitive fields you use)"
    }.`;
    confidence = "high";
  } else if (top && top.reason === "parent" && top.share >= 0.5) {
    headline = `${pct(top.share)} of renders were parent propagation with identical props.`;
    nextStep = `Measure ${component} with React.memo(). It is only worth it if ${fmt(totalSelf / mine.length)} per render matters here.`;
    confidence = "high";
  } else if (top && top.reason === "context") {
    headline = `${pct(top.share)} of renders followed a tracked context update.`;
    nextStep = "Check whether the provider's value is stable, and whether this component needs the whole context value.";
    confidence = "medium";
  } else if (top && (top.reason === "state" || top.reason === "state-or-external")) {
    headline = `${pct(top.share)} of renders came from inside the component — state or an external store.`;
    nextStep =
      top.reason === "state"
        ? "These are real state updates. Check whether every update needs to change state."
        : "Name the state with useTrackedState to see which value drives these renders.";
    confidence = top.reason === "state" ? "high" : "medium";
  } else if (top && top.reason === "props") {
    headline = `${pct(top.share)} of renders were driven by props with genuinely new values.`;
    nextStep = "These look like legitimate data changes. Look at render cost rather than render count.";
    confidence = "high";
  } else {
    headline = "Cause could not be determined reliably.";
    nextStep = "Instrument the parent, or track the context this component consumes, to narrow it down.";
    confidence = "low";
  }

  return {
    component,
    renders: mine.length,
    breakdown,
    unstableProps,
    averageSelfDuration: totalSelf / mine.length,
    totalSelfDuration: totalSelf,
    potentiallyAvoidableRenders: avoidable,
    estimatedAvoidableTime: avoidableTime,
    devReplays: replays,
    headline,
    nextStep,
    confidence,
  };
}

export function formatExplanation(e: Explanation): string {
  const lines: string[] = [
    `${e.component}`,
    "",
    `${e.renders} recorded render${e.renders === 1 ? "" : "s"}`,
    "",
    "Why?",
    `  ${e.headline}`,
    "",
    "Breakdown",
    ...e.breakdown.map((b) => `  ${b.reason.padEnd(18)} ${String(b.count).padStart(5)}  ${pct(b.share)}`),
  ];

  if (e.unstableProps.length > 0) {
    lines.push("", "Reference-only prop changes");
    for (const p of e.unstableProps) {
      lines.push(`  ${p.key.padEnd(18)} ${String(p.count).padStart(5)}  ${pct(p.share)}  (${p.valueType})`);
    }
  }

  lines.push(
    "",
    "Cost",
    `  average       ${fmt(e.averageSelfDuration)}`,
    `  total         ${fmt(e.totalSelfDuration)}`,
    `  potentially avoidable  ${e.potentiallyAvoidableRenders} render(s), ~${fmt(e.estimatedAvoidableTime)}`,
  );

  if (e.devReplays > 0) {
    lines.push(
      "",
      `  ${e.devReplays} development replay(s) observed (StrictMode double-invoke or discarded attempts) — excluded from the counts above.`,
    );
  }

  lines.push("", "Next step", `  ${e.nextStep}`, "", `Confidence: ${e.confidence}`);
  return lines.join("\n");
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const fmt = (ms: number): string => `${ms.toFixed(1)}ms`;
