import type { Confidence, RenderEvent, RenderReason } from "./types.js";

export interface Explanation {
  component: string;
  /** `File.tsx:12:2`, when the build plugin instrumented this component. */
  source?: string;
  /** Where the component's props come from, and its source if known. */
  parent?: { name: string; source?: string };
  renders: number;
  /** Mounts are excluded from every share below — they cannot be optimised away. */
  mounts: number;
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

  /*
   * Shares are measured against *updates*, not against every recorded render.
   * Mounts happen once per instance and are not something you can optimise
   * away, so counting them in the denominator quietly deflates the share of
   * whatever is actually driving the re-renders — on a 20-row list, a prop
   * responsible for every single update reads as "33%".
   */
  const updates = mine.filter((e) => e.phase !== "mount");
  const denominator = updates.length || mine.length;

  const reasonCounts = new Map<RenderReason, number>();
  const unstable = new Map<string, { count: number; valueType: string }>();
  let totalSelf = 0;
  let avoidable = 0;
  let avoidableTime = 0;
  let replays = 0;
  let propsWithNewValues = 0;
  let propsReferenceOnly = 0;

  for (const e of mine) {
    reasonCounts.set(e.diagnosis.reason, (reasonCounts.get(e.diagnosis.reason) ?? 0) + 1);
    totalSelf += e.timings.selfDuration;
    if (e.devReplay) replays++;
    if (e.diagnosis.potentiallyAvoidable) {
      avoidable++;
      avoidableTime += e.timings.selfDuration;
    }
    if (e.diagnosis.reason === "props") {
      if (e.changedProps.some((c) => c.kind !== "reference")) propsWithNewValues++;
      else propsReferenceOnly++;
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
    .map(([key, v]) => ({ key, count: v.count, share: v.count / denominator, valueType: v.valueType }))
    .sort((a, b) => b.count - a.count);

  // Ranked over updates, for the same reason the shares are.
  const top = [...reasonCounts.entries()]
    .filter(([reason]) => reason !== "mount")
    .map(([reason, count]) => ({ reason, count, share: count / denominator }))
    .sort((a, b) => b.count - a.count)[0];
  const topProp = unstableProps[0];
  const latest = mine[mine.length - 1] as RenderEvent;

  let headline: string;
  let nextStep: string;
  let confidence: Confidence = "medium";

  if (topProp && topProp.share >= 0.5) {
    headline = `${pct(topProp.share)} of updates followed \`${topProp.key}\` changing by reference while its contents stayed the same.`;
    // `parent` is the nearest instrumented ancestor — where the prop arrives
    // from, which is not necessarily where it is created. Say the former.
    const via = latest.parent?.name;
    const viaSource = latest.parent?.source ? ` (${latest.parent.source})` : "";
    nextStep =
      `Trace \`${topProp.key}\` back from ${via ? `${via}${viaSource}, which passes it to ${component}` : component}, ` +
      `and stabilise it where it is created${
        topProp.valueType === "function" ? " (useCallback, or hoist it out of the component)" : " (useMemo, or pass the primitive fields you use)"
      }.`;
    confidence = "high";
  } else if (top && top.reason === "parent" && top.share >= 0.5) {
    headline = `${pct(top.share)} of updates were parent propagation with identical props.`;
    nextStep = `Measure ${component} with React.memo(). It is only worth it if ${fmt(totalSelf / mine.length)} per render matters here.`;
    confidence = "high";
  } else if (top && top.reason === "context") {
    headline = `${pct(top.share)} of updates followed a tracked context update.`;
    nextStep = "Check whether the provider's value is stable, and whether this component needs the whole context value.";
    confidence = "medium";
  } else if (top && (top.reason === "state" || top.reason === "state-or-external")) {
    headline = `${pct(top.share)} of updates came from inside the component — state or an external store.`;
    nextStep =
      top.reason === "state"
        ? "These are real state updates. Check whether every update needs to change state."
        : "Name the state with useTrackedState to see which value drives these renders.";
    confidence = top.reason === "state" ? "high" : "medium";
  } else if (top && top.reason === "props") {
    // Do not call a bucket "new values" without checking that it holds any.
    if (propsReferenceOnly > propsWithNewValues) {
      headline = `${pct(propsReferenceOnly / denominator)} of updates were prop changes where only the reference changed — the contents were identical.`;
      nextStep = `Stabilise the props listed above in whichever component renders ${component}.`;
      confidence = "high";
    } else if (propsReferenceOnly > 0) {
      headline =
        `${pct(propsWithNewValues / denominator)} of updates carried genuinely new prop values, ` +
        `and ${pct(propsReferenceOnly / denominator)} changed by reference only.`;
      nextStep = "The reference-only ones are the avoidable half — start there.";
      confidence = "high";
    } else {
      headline = `${pct(top.share)} of updates were driven by props with genuinely new values.`;
      nextStep = "These look like legitimate data changes. Look at render cost rather than render count.";
      confidence = "high";
    }
  } else {
    headline = "Cause could not be determined reliably.";
    nextStep = "Instrument the parent, or track the context this component consumes, to narrow it down.";
    confidence = "low";
  }

  return {
    component,
    source: latest.component.source,
    parent: latest.parent ? { name: latest.parent.name, source: latest.parent.source } : undefined,
    renders: mine.length,
    mounts: mine.length - updates.length,
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
    e.source ? `${e.component}   ${e.source}` : `${e.component}`,
    "",
    `${e.renders} recorded render${e.renders === 1 ? "" : "s"}${e.mounts > 0 ? ` (${e.mounts} mount${e.mounts === 1 ? "" : "s"})` : ""}`,
    "",
    "Why?",
    `  ${e.headline}`,
    "",
    "Breakdown (share of all renders)",
    ...e.breakdown.map((b) => `  ${b.reason.padEnd(18)} ${String(b.count).padStart(5)}  ${pct(b.share)}`),
  ];

  if (e.unstableProps.length > 0) {
    lines.push("", "Reference-only prop changes (share of updates)");
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
