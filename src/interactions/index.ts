/**
 * Interaction and INP attribution — opt-in.
 *
 * Split out of the root entry in 0.6.0. It was started by `init()`, which meant
 * every consumer paid ~2 KB for it whether or not they used it, and the root
 * entry's budget had then been raised three releases running. Splitting was the
 * committed alternative to raising it a fourth time.
 *
 *   import { startInteractionTracking, printInteractions } from "react-render-detective/interactions";
 *   startInteractionTracking();
 */
import { formatInteraction, InteractionTracker, summarise } from "../core/interactions.js";
import type { InteractionRecord, InteractionSummary } from "../core/interactions.js";
import { getDetective } from "../core/store.js";

const TRACKER = Symbol.for("react-render-detective.interactions");
type Global = typeof globalThis & { [TRACKER]?: InteractionTracker };

function tracker(): InteractionTracker {
  const g = globalThis as Global;
  if (!g[TRACKER]) {
    const created = new InteractionTracker();
    g[TRACKER] = created;
    // Follow the detective's lifecycle so `clear()` and `reset()` stay coherent
    // without the root entry needing to know this module exists.
    const detective = getDetective();
    detective.registerClearHook(() => created.clear());
    detective.registerResetHook(() => {
      created.stop();
      (globalThis as Global)[TRACKER] = undefined;
    });
  }
  return g[TRACKER] as InteractionTracker;
}

/**
 * Begin capturing interactions. Returns `false` where the browser cannot report
 * event timing (Safari before 16.4, jsdom) — use `measureInteraction` there.
 */
export function startInteractionTracking(): boolean {
  return tracker().start();
}

export function stopInteractionTracking(): void {
  tracker().stop();
}

/** Interactions, slowest first, with the renders committed inside each. */
export function getInteractions(): InteractionRecord[] {
  return tracker().attribute(getDetective().getEvents());
}

/** Structured analysis of one interaction. Defaults to the slowest recorded. */
export function explainInteractionStructured(id?: string): InteractionSummary | undefined {
  const records = getInteractions();
  const record = id ? records.find((r) => r.id === id) : records[0];
  return record ? summarise(record) : undefined;
}

export function explainInteraction(id?: string): string | undefined {
  const summary = explainInteractionStructured(id);
  return summary ? formatInteraction(summary) : undefined;
}

export function printInteractions(limit = 5): void {
  const records = getInteractions().slice(0, limit);
  if (records.length === 0) {
    console.log(
      tracker().automatic
        ? "No interactions recorded yet. Event timing is working — nothing has taken longer than 16ms.\n" +
            "Synthetic clicks from a test harness never produce these entries; use measureInteraction() there."
        : "This browser does not report event timing (Safari before 16.4, jsdom), or tracking was never started.\n" +
            "Call startInteractionTracking(), or use measureInteraction(label, fn) to time interactions by hand.",
    );
    return;
  }
  console.log(records.map((r) => formatInteraction(summarise(r))).join("\n\n"));
}

/**
 * Time one interaction explicitly, up to the paint that follows it. Needed
 * wherever the automatic path cannot see: Safari before 16.4, and any synthetic
 * input, which never produces Event Timing entries.
 */
export function measureInteraction<T>(label: string, action: () => T): T {
  return tracker().measure(label, action);
}

export { InteractionTracker, summarise as summariseInteraction, formatInteraction } from "../core/interactions.js";
export type { InteractionRecord, InteractionSummary } from "../core/interactions.js";
