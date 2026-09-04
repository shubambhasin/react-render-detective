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
  /** Store selectors that returned a new reference with identical contents. */
  unstableSelectors: Array<{ name: string; source?: string; count: number; share: number }>;
  averageSelfDuration: number;
  totalSelfDuration: number;
  potentiallyAvoidableRenders: number;
  estimatedAvoidableTime: number;
  devReplays: number;
  /** Times the component was rebuilt rather than re-rendered. */
  remounts: number;
  headline: string;
  nextStep: string;
  confidence: Confidence;
}

/**
 * The flagship "explain this render" answer, aggregated across the recorded
 * history of one component. Pure — no React, no console.
 */
export function explainEvents(
  component: string,
  events: RenderEvent[],
  lifecycle?: { remounts: number },
): Explanation | undefined {
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
  const unstableSelector = new Map<string, { count: number; source?: string }>();
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
    for (const c of e.selectorChanges) {
      if (!c.referenceOnly) continue;
      const entry = unstableSelector.get(c.name) ?? { count: 0, source: c.source };
      entry.count++;
      unstableSelector.set(c.name, entry);
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

  const unstableSelectors = [...unstableSelector.entries()]
    .map(([name, v]) => ({ name, source: v.source, count: v.count, share: v.count / denominator }))
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
  const topSelector = unstableSelectors[0];
  const latest = mine[mine.length - 1] as RenderEvent;

  let headline: string;
  let nextStep: string;
  let confidence: Confidence = "medium";

  const remounts = lifecycle?.remounts ?? 0;

  /*
   * Remounts outrank every render explanation. A component being rebuilt is
   * throwing away its DOM and its state, which costs more than any number of
   * re-renders — so if that is happening, it is the headline.
   */
  if (remounts >= 2) {
    const mountEvent = [...mine].reverse().find((e) => e.phase === "mount");
    headline = `${component} was rebuilt ${remounts}× rather than re-rendered — its DOM and state were discarded each time.`;
    nextStep =
      mountEvent?.diagnosis.suggestion ??
      `Check whether ${component} is declared inside another component's render body, or receives a changing \`key\`.`;
    confidence = mountEvent?.diagnosis.confidence ?? "medium";
  } else if (topSelector && topSelector.share >= 0.5) {
    /*
     * Ranked above props: a selector rebuilding its value re-renders the
     * component on *every* store update, so it is usually the larger cause.
     */
    headline =
      `${pct(topSelector.share)} of updates followed the \`${topSelector.name}\` selector returning a new reference ` +
      `with identical contents — so this re-renders on every store update, not only when its data changes.`;
    nextStep =
      `Make \`${topSelector.name}\`${topSelector.source ? ` at ${topSelector.source}` : ""} return a stable value: ` +
      `select the raw slice and derive outside the selector, memoize with createSelector, or pass shallowEqual.`;
    confidence = "high";
  } else if (topProp && topProp.share >= 0.5) {
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
  } else if (top && top.reason === "store") {
    headline = `${pct(top.share)} of updates came from tracked store selectors whose values genuinely changed.`;
    nextStep =
      "These are real data changes. Look at what each render costs rather than how many there are, " +
      "or select less per component so fewer components wake on each store update.";
    confidence = "high";
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
    unstableSelectors,
    potentiallyAvoidableRenders: avoidable,
    estimatedAvoidableTime: avoidableTime,
    devReplays: replays,
    remounts,
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

  if (e.unstableSelectors.length > 0) {
    lines.push("", "Selectors returning a new reference each call (share of updates)");
    for (const sel of e.unstableSelectors) {
      lines.push(`  ${sel.name.padEnd(24)} ${String(sel.count).padStart(5)}  ${pct(sel.share)}${sel.source ? `  ${sel.source}` : ""}`);
    }
  }

  if (e.unstableProps.length > 0) {
    lines.push("", "Reference-only prop changes (share of updates)");
    for (const p of e.unstableProps) {
      lines.push(`  ${p.key.padEnd(18)} ${String(p.count).padStart(5)}  ${pct(p.share)}  (${p.valueType})`);
    }
  }

  if (e.remounts > 0) {
    lines.push("", `Rebuilt ${e.remounts}× (unmounted and mounted again — state and DOM discarded)`);
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
