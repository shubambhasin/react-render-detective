import type { Confidence, RenderEvent } from "./types.js";

/**
 * Interaction-scoped attribution.
 *
 * Performance is felt per interaction, not in aggregate — and INP is the metric
 * teams are actually judged on. This joins the two halves: the browser says a
 * keystroke took 240ms, and the render events say which components spent it and
 * why.
 *
 * Uses `PerformanceObserver` with `event` timing, a public browser API. Where it
 * is unsupported (older Safari, jsdom) interaction tracking simply stays empty
 * rather than guessing.
 */
export interface InteractionRecord {
  id: string;
  /** `click`, `keydown`, `pointerup`… */
  type: string;
  /** Best-effort description of what was interacted with. */
  target?: string;
  startTime: number;
  /** Browser-reported event duration — the number INP is computed from. */
  durationMs: number;
  /**
   * For a manually measured interaction: how long the synchronous action took.
   * Immune to throttling, unlike the full window, which waits on a frame.
   */
  handlerMs?: number;
  /** Renders committed inside this interaction's window. */
  renders: RenderEvent[];
  /** Sum of self durations for those renders. */
  renderTimeMs: number;
  /** Render time that no observable input change explains. */
  avoidableRenderTimeMs: number;
}

export interface InteractionSummary {
  interaction: InteractionRecord;
  /** Components ordered by cost within this interaction. */
  contributors: Array<{ component: string; source?: string; renders: number; totalMs: number; cause: string }>;
  headline: string;
  nextStep: string;
  confidence: Confidence;
}

/** Entries React commits slightly after the event finishes; allow for that. */
const COMMIT_SLACK_MS = 100;

/** Used when requestAnimationFrame cannot fire — a hidden tab, or jsdom. */
const FALLBACK_CLOSE_MS = 50;

interface RawEventTiming {
  name: string;
  startTime: number;
  duration: number;
  target?: string;
  handlerMs?: number;
}

export class InteractionTracker {
  private records: InteractionRecord[] = [];
  private observer: { disconnect: () => void } | undefined;
  private nextId = 0;

  constructor(private capacity = 50) {}

  /** Returns false when the browser cannot report event timing. */
  start(): boolean {
    if (this.observer) return true;
    const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    const supported = PO?.supportedEntryTypes?.includes("event");
    if (!PO || !supported) return false;

    try {
      const observer = new PO((list) => {
        for (const entry of list.getEntries()) {
          const timing = entry as PerformanceEntry & { duration: number; target?: Element };
          this.record({
            name: timing.name,
            startTime: timing.startTime,
            duration: timing.duration,
            target: describeTarget(timing.target),
          });
        }
      });
      // 16ms: anything that misses a frame is worth attributing.
      observer.observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
      this.observer = observer;
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }

  /** Is the automatic path available in this browser? */
  get automatic(): boolean {
    return this.observer !== undefined;
  }

  /**
   * Time an interaction by hand.
   *
   * The automatic path depends on the Event Timing API, which Safari only
   * gained in 16.4 and which does not fire for synthetic input at all — so
   * anything driven by a test harness records nothing. This measures a specific
   * action instead, up to the paint that follows it, and needs no browser
   * support beyond `performance.now`.
   */
  measure<T>(label: string, action: () => T): T {
    const startTime = now();
    let handlerMs = 0;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.record({ name: label, startTime, duration: now() - startTime, handlerMs });
    };

    let result: T;
    try {
      result = action();
      handlerMs = now() - startTime;
    } catch (error) {
      handlerMs = now() - startTime;
      finish();
      throw error;
    }

    /*
     * Close the window after the frame in which React commits and paints.
     *
     * The timer is not belt-and-braces: `requestAnimationFrame` does not fire
     * in a hidden tab, and does not exist in jsdom, so without it an
     * interaction would simply never be recorded. Whichever fires first wins;
     * the fallback is long enough that rAF normally does.
     */
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame;
    if (raf) raf(() => raf(finish));
    setTimeout(finish, FALLBACK_CLOSE_MS);

    return result;
  }

  /** Exposed for tests and for `measure`. */
  record(timing: RawEventTiming): InteractionRecord {
    const record: InteractionRecord = {
      id: `interaction_${++this.nextId}`,
      type: timing.name,
      target: timing.target,
      startTime: timing.startTime,
      durationMs: timing.duration,
      handlerMs: timing.handlerMs,
      renders: [],
      renderTimeMs: 0,
      avoidableRenderTimeMs: 0,
    };
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.shift();
    return record;
  }

  clear(): void {
    this.records.length = 0;
  }

  /**
   * Joins render events to interactions by commit time. A render belongs to an
   * interaction when it committed between the event starting and shortly after
   * it finished — React commits just after the event handler returns.
   */
  attribute(events: RenderEvent[]): InteractionRecord[] {
    for (const record of this.records) {
      const from = record.startTime;
      const to = record.startTime + record.durationMs + COMMIT_SLACK_MS;
      record.renders = events.filter((e) => e.timings.commitTime >= from && e.timings.commitTime <= to);
      record.renderTimeMs = record.renders.reduce((a, e) => a + e.timings.selfDuration, 0);
      record.avoidableRenderTimeMs = record.renders
        .filter((e) => e.diagnosis.potentiallyAvoidable)
        .reduce((a, e) => a + e.timings.selfDuration, 0);
    }
    return [...this.records].sort((a, b) => b.durationMs - a.durationMs);
  }
}

export function summarise(record: InteractionRecord): InteractionSummary {
  const byComponent = new Map<string, { renders: number; totalMs: number; source?: string; cause: string }>();
  for (const event of record.renders) {
    const entry = byComponent.get(event.component.name) ?? {
      renders: 0,
      totalMs: 0,
      source: event.component.source,
      cause: event.diagnosis.reason,
    };
    entry.renders++;
    entry.totalMs += event.timings.selfDuration;
    byComponent.set(event.component.name, entry);
  }

  const contributors = [...byComponent.entries()]
    .map(([component, v]) => ({ component, source: v.source, renders: v.renders, totalMs: v.totalMs, cause: v.cause }))
    .sort((a, b) => b.totalMs - a.totalMs);

  const top = contributors[0];

  /*
   * A manually measured window waits for a frame, and a throttled or hidden tab
   * can stretch that to hundreds of milliseconds of pure idling. Attributing
   * that to the app would be inventing a problem, so when the window is far
   * larger than the work inside it, reason about the work instead.
   */
  const accounted = (record.handlerMs ?? record.durationMs) + record.renderTimeMs;
  const idleWindow = record.handlerMs !== undefined && record.durationMs > accounted * 3 && record.durationMs - accounted > 100;
  const effectiveMs = idleWindow ? accounted : record.durationMs;
  const share = effectiveMs > 0 ? record.renderTimeMs / effectiveMs : 0;

  let headline: string;
  let nextStep: string;
  let confidence: Confidence = "medium";

  if (idleWindow) {
    headline =
      `${record.type}: ${fmt(record.handlerMs ?? 0)} in the handler and ${fmt(record.renderTimeMs)} rendering. ` +
      `The measured window was ${fmt(record.durationMs)}, but most of that was the page waiting for a frame — ignore it.`;
    nextStep =
      record.renderTimeMs > (record.handlerMs ?? 0)
        ? `Rendering dominates the real work${top ? `; start with ${top.component}` : ""}.`
        : "The handler itself costs more than rendering. Profile the handler, not React.";
    return { interaction: record, contributors, headline, nextStep, confidence: "medium" };
  }

  if (record.renders.length === 0) {
    headline = `${record.type} took ${fmt(record.durationMs)}, and no instrumented component rendered inside it.`;
    nextStep =
      "The cost is somewhere other than React rendering — an event handler, a layout, or an uninstrumented component. Instrument more of the tree to narrow it down.";
    confidence = "low";
  } else if (share >= 0.4 && record.avoidableRenderTimeMs > 0) {
    headline =
      `${record.type} took ${fmt(record.durationMs)}; ${fmt(record.renderTimeMs)} of it was rendering, ` +
      `and ${fmt(record.avoidableRenderTimeMs)} of that had no input change to explain it.`;
    nextStep = top
      ? `Start with ${top.component}${top.source ? ` (${top.source})` : ""} — ${fmt(top.totalMs)} across ${top.renders} render${top.renders === 1 ? "" : "s"}.`
      : "Look at the top contributor below.";
    confidence = "high";
  } else if (share >= 0.4) {
    headline = `${record.type} took ${fmt(record.durationMs)}; ${fmt(record.renderTimeMs)} of it was rendering, all of it explained by real input changes.`;
    nextStep = "This is genuine work. Make the renders cheaper rather than fewer — or do less of it per interaction.";
    confidence = "high";
  } else {
    headline = `${record.type} took ${fmt(record.durationMs)}, but only ${fmt(record.renderTimeMs)} was React rendering.`;
    nextStep = "Most of the cost is outside rendering — event handlers, layout or paint. A browser profile will show more than this tool can.";
    confidence = "medium";
  }

  return { interaction: record, contributors, headline, nextStep, confidence };
}

export function formatInteraction(summary: InteractionSummary): string {
  const { interaction: i } = summary;
  const lines = [
    `${i.type}${i.target ? ` on ${i.target}` : ""}   ${fmt(i.durationMs)}`,
    "",
    summary.headline,
  ];

  if (summary.contributors.length > 0) {
    lines.push("", "Rendering inside this interaction");
    for (const c of summary.contributors.slice(0, 8)) {
      lines.push(
        `  ${c.component.padEnd(22)} ${String(c.renders).padStart(4)} render(s)  ${fmt(c.totalMs).padStart(8)}  ${c.cause}`,
      );
    }
  }

  lines.push("", `Next step`, `  ${summary.nextStep}`, "", `Confidence: ${summary.confidence}`);
  return lines.join("\n");
}

function describeTarget(target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const el = target as { tagName?: string; id?: string; className?: unknown; textContent?: string | null };
  if (!el.tagName) return undefined;
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const className = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : undefined;
  if (className) return `${tag}.${className}`;
  const text = el.textContent?.trim().slice(0, 20);
  return text ? `${tag} "${text}"` : tag;
}

const fmt = (ms: number): string => `${ms.toFixed(1)}ms`;

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
