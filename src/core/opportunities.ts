import { explainEvents } from "./explain.js";
import type { Confidence, RenderEvent } from "./types.js";

/**
 * "Where should I spend my next hour?"
 *
 * Render counts answer the wrong question — a component rendering 2 000 times
 * for 0.01ms is not the problem, and one rendering 40 times for 12ms might be.
 * This ranks by **estimated recoverable time**, so the top of the list is the
 * biggest win rather than the noisiest component.
 */
export interface Opportunity {
  component: string;
  source?: string;
  /** Milliseconds plausibly recovered by fixing this. The ranking key. */
  estimatedSavingMs: number;
  /** Renders where no observable input changed. */
  avoidableRenders: number;
  /** Times the component was rebuilt rather than re-rendered. */
  remounts: number;
  averageSelfDuration: number;
  /** One line: what to look at. Comes from the diagnostic engine, not from here. */
  summary: string;
  nextStep: string;
  confidence: Confidence;
}

export interface OpportunityInput {
  events: RenderEvent[];
  lifecycles: Map<string, { remounts: number }>;
  /** Ignore anything below this. Noise is worse than silence in a ranked list. */
  minSavingMs?: number;
}

const DEFAULT_MIN_SAVING_MS = 1;

export function rankOpportunities({ events, lifecycles, minSavingMs = DEFAULT_MIN_SAVING_MS }: OpportunityInput): Opportunity[] {
  const names = new Set(events.map((e) => e.component.name));
  const out: Opportunity[] = [];

  for (const name of names) {
    const lifecycle = lifecycles.get(name);
    const explanation = explainEvents(name, events, lifecycle);
    if (!explanation) continue;

    /*
     * A remount is charged at the cost of a mount, because that is what it is:
     * React rebuilds the subtree. Avoidable renders are charged at what they
     * actually cost. Both are estimates and are labelled as such — the point is
     * an ordering, not a promise.
     */
    const mounts = events.filter((e) => e.component.name === name && e.phase === "mount");
    const averageMountCost = mounts.length
      ? mounts.reduce((a, e) => a + e.timings.selfDuration, 0) / mounts.length
      : 0;
    const remountSaving = explanation.remounts * averageMountCost;
    const estimatedSavingMs = explanation.estimatedAvoidableTime + remountSaving;

    if (estimatedSavingMs < minSavingMs) continue;

    out.push({
      component: name,
      source: explanation.source,
      estimatedSavingMs,
      avoidableRenders: explanation.potentiallyAvoidableRenders,
      remounts: explanation.remounts,
      averageSelfDuration: explanation.averageSelfDuration,
      summary: explanation.headline,
      nextStep: explanation.nextStep,
      confidence: explanation.confidence,
    });
  }

  return out.sort((a, b) => b.estimatedSavingMs - a.estimatedSavingMs);
}

export function formatOpportunities(opportunities: Opportunity[]): string {
  if (opportunities.length === 0) {
    return "React Render Detective\n\nNo measurable render waste found yet. Interact with the app and try again.";
  }

  const lines = [
    "React Render Detective — where to spend your next hour",
    "",
    "Ranked by estimated recoverable time. These are estimates, not promises:",
    "measure each fix.",
    "",
  ];

  for (const [index, o] of opportunities.entries()) {
    lines.push(
      `${String(index + 1).padStart(2)}. ${o.component}${o.source ? `   ${o.source}` : ""}`,
      `    ~${o.estimatedSavingMs.toFixed(0)}ms recoverable   ` +
        `${o.avoidableRenders} avoidable render${o.avoidableRenders === 1 ? "" : "s"}` +
        `${o.remounts > 0 ? `, ${o.remounts}× rebuilt` : ""}   (confidence: ${o.confidence})`,
      `    ${o.summary}`,
      `    → ${o.nextStep}`,
      "",
    );
  }

  return lines.join("\n");
}
