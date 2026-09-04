import { formatInspected } from "../core/inspect.js";
import { styled } from "./style.js";
import type { Segment, Tone } from "./style.js";
import type { Detective } from "../core/store.js";
import type { PropChange, RenderEvent } from "../core/types.js";

const ICON: Record<string, string> = {
  normal: "·",
  monitor: "•",
  slow: "▲",
  "very-slow": "▲▲",
  critical: "■",
};

/** Batches are coalesced over this window so a burst prints once. */
const BATCH_WINDOW_MS = 400;

/**
 * Console output.
 *
 * `console` mode reports **commits, not renders**. One line per render is
 * unusable in a real application: a 20-row list mounting produced ~200 lines of
 * `FareTile #1 mount 0.1ms`, which Chrome then collapsed into `2×` markers —
 * pure noise that also slowed the app being measured. Worse, it buried the two
 * or three lines that actually mattered.
 *
 * So a batch is summarised, and a batch that contains nothing actionable is not
 * printed at all. `verbose` keeps the old per-render detail for when you have
 * narrowed to one component with `include`.
 */
export function attachConsoleReporter(detective: Detective): () => void {
  let pending: RenderEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    try {
      printBatch(batch, detective.config.slowRenderThreshold);
    } catch {
      /* diagnostics must never break the app */
    }
  };

  const unsubscribe = detective.subscribe((event) => {
    const mode = detective.config.mode;
    if (mode === "silent") return;

    if (mode === "verbose") {
      try {
        printVerbose(event);
      } catch {
        /* ignore */
      }
      return;
    }

    pending.push(event);
    if (timer === undefined) {
      timer = setTimeout(flush, BATCH_WINDOW_MS);
      (timer as { unref?: () => void }).unref?.();
    }
  });

  return () => {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  };
}

interface Aggregate {
  name: string;
  source?: string;
  count: number;
  totalMs: number;
  reasons: Map<string, number>;
  /** Reasons of the renders that were actually actionable. */
  notableReasons: Map<string, number>;
  avoidable: number;
  remount: boolean;
  slow: boolean;
  worst?: RenderEvent;
}

function printBatch(batch: RenderEvent[], slowThreshold: number): void {
  const byComponent = new Map<string, Aggregate>();
  let totalMs = 0;
  let avoidable = 0;

  for (const event of batch) {
    const key = event.component.name;
    const entry = byComponent.get(key) ?? {
      name: key,
      source: event.component.source,
      count: 0,
      totalMs: 0,
      reasons: new Map<string, number>(),
      notableReasons: new Map<string, number>(),
      avoidable: 0,
      remount: false,
      slow: false,
    };
    entry.count++;
    entry.totalMs += event.timings.selfDuration;
    entry.reasons.set(event.diagnosis.reason, (entry.reasons.get(event.diagnosis.reason) ?? 0) + 1);
    if (event.diagnosis.potentiallyAvoidable || event.timings.selfDuration >= slowThreshold) {
      entry.notableReasons.set(event.diagnosis.reason, (entry.notableReasons.get(event.diagnosis.reason) ?? 0) + 1);
    }
    if (event.diagnosis.potentiallyAvoidable) entry.avoidable++;
    if (event.diagnosis.summary.includes("rebuilt")) entry.remount = true;
    if (event.timings.selfDuration >= slowThreshold) entry.slow = true;
    if (!entry.worst || event.timings.selfDuration > entry.worst.timings.selfDuration) entry.worst = event;
    byComponent.set(key, entry);

    totalMs += event.timings.selfDuration;
    if (event.diagnosis.potentiallyAvoidable) avoidable++;
  }

  /*
   * Silence is the default. Renders that are cheap and fully explained are
   * normal behaviour, and reporting them trains people to ignore the console.
   */
  const notable = [...byComponent.values()].filter((a) => a.avoidable > 0 || a.slow || a.remount);
  if (notable.length === 0) return;

  const ranked = [...notable].sort((a, b) => b.totalMs - a.totalMs);
  const anySlow = ranked.some((a) => a.slow);

  const segments: Segment[] = [
    ["[RRD] ", "dim"],
    [`${batch.length} render${batch.length === 1 ? "" : "s"}`, "strong"],
    [` · ${totalMs.toFixed(1)}ms`, "dim"],
  ];
  if (avoidable > 0) segments.push([` · ${avoidable} potentially avoidable`, "warn"]);

  for (const a of ranked.slice(0, 8)) {
    /*
     * Show why the *actionable* renders happened. A batch containing 12 mounts
     * and 12 avoidable updates would otherwise be labelled "mount", which is
     * the half nobody can do anything about.
     */
    const reasonSource = a.notableReasons.size > 0 ? a.notableReasons : a.reasons;
    const reason = [...reasonSource.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "unknown";

    // Worst-first: a rebuild costs more than a slow render, which costs more
    // than an avoidable one.
    const tone: Tone = a.remount ? "bad" : a.slow ? "warn" : a.avoidable > 0 ? "warn" : "good";
    const label = `  ${ICON[a.slow ? "slow" : "normal"]} ${a.name}${a.count > 1 ? ` ×${a.count}` : ""}`;

    segments.push("\n", [label.padEnd(30), tone], [`${a.totalMs.toFixed(1)}ms`, "plain"], [`  ${reason}`, "dim"]);
    if (a.remount) segments.push(["  rebuilt", "bad"]);
    if (a.avoidable > 0) segments.push([`  ${a.avoidable} avoidable`, "warn"]);
    if (a.source) segments.push(["\n      " + a.source, "dim"]);
  }

  const worst = ranked[0]?.worst;
  segments.push(
    "\n",
    [
      worst?.diagnosis.suggestion
        ? `  → ${worst.diagnosis.suggestion}`
        : "  → rrd.printOpportunities() to rank everything by recoverable time",
      "dim",
    ],
  );

  const log = anySlow ? console.warn : console.log;
  log(...styled(segments));
}

function printVerbose(event: RenderEvent): void {
  const { diagnosis, timings } = event;
  const header = `[RRD] ${event.component.name} #${event.renderNumber} — ${diagnosis.summary}`;

  const group = diagnosis.severity === "normal" ? console.groupCollapsed : console.group;
  group.call(console, header);
  try {
    console.log(`Cause:       ${label(event)} (confidence: ${diagnosis.confidence})`);
    if (event.component.source) console.log(`Source:      ${event.component.source}`);
    if (event.parent) {
      console.log(
        `Parent:      ${event.parent.name}${event.parent.source ? ` (${event.parent.source})` : ""}` +
          `${event.parentRendered ? " — re-rendered in this commit" : " — did not re-render"}`,
      );
    }
    console.log(
      `Cost:        self ${timings.selfDuration.toFixed(1)}ms · subtree ${timings.subtreeDuration.toFixed(1)}ms` +
        (timings.accountedDescendantDuration > 0
          ? ` (${timings.accountedDescendantDuration.toFixed(1)}ms in instrumented children)`
          : ""),
    );

    if (event.changedProps.length > 0) {
      console.groupCollapsed(`Props changed (${event.changedProps.length})`);
      for (const c of event.changedProps) console.log(propLine(c));
      console.groupEnd();
    }
    if (event.unchangedProps.length > 0) console.log(`Props same:  ${event.unchangedProps.join(", ")}`);
    if (event.trackedState.length > 0) {
      console.log(
        `State:       ${event.trackedState
          .map((s) => `${s.name}: ${formatInspected(s.previous)} → ${formatInspected(s.current)}`)
          .join(", ")}`,
      );
    }
    if (event.contextChanges.length > 0) {
      console.log(`Context:     ${event.contextChanges.map((c) => c.contextName).join(", ")} changed in this commit`);
    }

    console.groupCollapsed("Evidence");
    for (const line of diagnosis.evidence) console.log(`• ${line}`);
    console.groupEnd();

    if (diagnosis.suggestion) console.log(`Next step:   ${diagnosis.suggestion}`);
    if (diagnosis.potentiallyAvoidable) console.log("Flag:        potentially avoidable render");
  } finally {
    console.groupEnd();
  }
}

function propLine(c: PropChange): string {
  const head = `${c.key} (${c.valueType}) — ${describeKind(c)}`;
  if (c.kind === "added") return `${head}: ${formatInspected(c.current)}`;
  if (c.kind === "removed") return `${head}: was ${formatInspected(c.previous)}`;
  return `${head}\n    previous: ${formatInspected(c.previous)}\n    current:  ${formatInspected(c.current)}`;
}

function describeKind(c: PropChange): string {
  switch (c.kind) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "value":
      return "value changed";
    case "reference":
      if (c.valueType === "function") return c.sourceEqual ? "new function, identical source" : "new function reference";
      return c.shallowEqual === true ? "reference changed, contents identical" : "reference changed";
  }
}

function label(event: RenderEvent): string {
  switch (event.diagnosis.reason) {
    case "mount":
      return "mount";
    case "props":
      return event.changedProps.every((c) => c.kind === "reference") ? "prop changed (reference only)" : "prop changed";
    case "parent":
      return "parent rendered";
    case "context":
      return "context update";
    case "state":
      return "state changed";
    case "store":
      return "store update";
    case "state-or-external":
      return "state or external store";
    case "unknown":
      return "undetermined";
  }
}
