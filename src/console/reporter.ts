import { formatInspected } from "../core/inspect.js";
import type { Detective } from "../core/store.js";
import type { PropChange, RenderEvent } from "../core/types.js";

const ICON: Record<string, string> = {
  normal: "·",
  monitor: "•",
  slow: "▲",
  "very-slow": "▲▲",
  critical: "■",
};

/** Attaches console output. Returns an unsubscribe so init() stays idempotent. */
export function attachConsoleReporter(detective: Detective): () => void {
  return detective.subscribe((event) => {
    const mode = detective.config.mode;
    if (mode === "silent") return;
    try {
      if (mode === "verbose") printVerbose(event);
      else printConcise(event, detective.config.slowRenderThreshold);
    } catch {
      /* ignore */
    }
  });
}

function printConcise(event: RenderEvent, slowThreshold: number): void {
  const { diagnosis, timings, component } = event;
  const changed = event.changedProps.map((c) => c.key).join(", ");
  const parts = [
    `[RRD] ${component.name} #${event.renderNumber}`,
    `Reason: ${label(event)}`,
    changed ? `Changed: ${changed}` : undefined,
    timings.subtreeDuration > 0 ? `Duration: ${timings.selfDuration.toFixed(1)}ms` : undefined,
  ].filter(Boolean);

  const line = `${ICON[diagnosis.severity] ?? "·"} ${parts.join("  ")}`;
  const slow = timings.selfDuration >= slowThreshold;
  if (slow) console.warn(line);
  else console.log(line);
}

function printVerbose(event: RenderEvent): void {
  const { diagnosis, timings } = event;
  const header = `[RRD] ${event.component.name} #${event.renderNumber} — ${diagnosis.summary}`;

  const group = diagnosis.severity === "normal" ? console.groupCollapsed : console.group;
  group.call(console, header);
  try {
    console.log(`Cause:       ${label(event)} (confidence: ${diagnosis.confidence})`);
    if (event.parent) {
      console.log(`Parent:      ${event.parent.name}${event.parentRendered ? " (re-rendered in this commit)" : " (did not re-render)"}`);
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
    if (event.unchangedProps.length > 0) {
      console.log(`Props same:  ${event.unchangedProps.join(", ")}`);
    }
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
    case "state-or-external":
      return "state or external store";
    case "unknown":
      return "undetermined";
  }
}
