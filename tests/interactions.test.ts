import { describe, expect, it } from "vitest";
import { InteractionTracker, formatInteraction, summarise } from "../src/core/interactions.js";
import type { RenderEvent } from "../src/core/types.js";

const event = (over: Partial<RenderEvent> & { name: string; commitTime: number; selfDuration: number; avoidable?: boolean }): RenderEvent =>
  ({
    id: `${over.name}#1`,
    component: { id: "n1", name: over.name, source: `src/${over.name}.tsx:1:1`, depth: 0 },
    timestamp: over.commitTime,
    renderNumber: 1,
    phase: "update",
    timings: {
      subtreeDuration: over.selfDuration,
      baseDuration: over.selfDuration,
      selfDuration: over.selfDuration,
      accountedDescendantDuration: 0,
      commitTime: over.commitTime,
      startTime: over.commitTime,
    },
    changedProps: [],
    unchangedProps: [],
    parentRendered: false,
    selfOriginated: false,
    contextChanges: [],
    trackedState: [],
    committed: true,
    attempts: 1,
    devReplay: false,
    diagnosis: {
      reason: "props",
      confidence: "high",
      summary: "",
      evidence: [],
      potentiallyAvoidable: over.avoidable ?? false,
      severity: "normal",
    },
  }) as RenderEvent;

describe("interaction attribution", () => {
  it("attributes only the renders committed inside the interaction window", () => {
    const tracker = new InteractionTracker();
    tracker.record({ name: "click", startTime: 1000, duration: 200, target: "button#save" });

    const records = tracker.attribute([
      event({ name: "Before", commitTime: 900, selfDuration: 5 }),
      event({ name: "Inside", commitTime: 1050, selfDuration: 40, avoidable: true }),
      event({ name: "JustAfter", commitTime: 1250, selfDuration: 10 }), // within commit slack
      event({ name: "Later", commitTime: 5000, selfDuration: 90 }),
    ]);

    const names = records[0]?.renders.map((r) => r.component.name);
    expect(names).toEqual(["Inside", "JustAfter"]);
    expect(records[0]?.renderTimeMs).toBe(50);
    expect(records[0]?.avoidableRenderTimeMs).toBe(40);
  });

  it("says plainly when rendering dominates an interaction, and what to fix", () => {
    const tracker = new InteractionTracker();
    tracker.record({ name: "keydown", startTime: 0, duration: 240, target: "input#search" });
    const [record] = tracker.attribute([
      event({ name: "ProductTable", commitTime: 10, selfDuration: 120, avoidable: true }),
      event({ name: "Chart", commitTime: 20, selfDuration: 40 }),
    ]);

    const summary = summarise(record as never);
    expect(summary.confidence).toBe("high");
    expect(summary.headline).toContain("240.0ms");
    expect(summary.headline).toContain("no input change to explain it");
    expect(summary.contributors[0]?.component).toBe("ProductTable");
    expect(summary.nextStep).toContain("ProductTable");
    expect(formatInteraction(summary)).toContain("keydown on input#search");
  });

  it("does not blame React when rendering is a small part of the cost", () => {
    const tracker = new InteractionTracker();
    tracker.record({ name: "click", startTime: 0, duration: 300 });
    const [record] = tracker.attribute([event({ name: "Tiny", commitTime: 5, selfDuration: 3 })]);

    const summary = summarise(record as never);
    expect(summary.headline).toContain("only 3.0ms was React rendering");
    expect(summary.nextStep).toContain("outside rendering");
  });

  it("admits it cannot explain an interaction with no instrumented renders", () => {
    const tracker = new InteractionTracker();
    tracker.record({ name: "pointerup", startTime: 0, duration: 180 });
    const [record] = tracker.attribute([]);
    const summary = summarise(record as never);
    expect(summary.confidence).toBe("low");
    expect(summary.nextStep).toContain("Instrument more of the tree");
  });

  it("reports unsupported environments instead of pretending", () => {
    // jsdom has no `event` timing; the tracker must say so rather than invent.
    expect(new InteractionTracker().start()).toBe(false);
  });
});

describe("manual measurement", () => {
  it("times an action and records it, for environments the automatic path cannot see", async () => {
    const tracker = new InteractionTracker();
    // jsdom, Safari < 16.4, and every synthetic click: no event timing at all.
    expect(tracker.automatic).toBe(false);

    const result = tracker.measure("save button", () => {
      const start = performance.now();
      while (performance.now() - start < 5) {
        /* simulate work */
      }
      return "done";
    });

    expect(result).toBe("done");
    await new Promise((r) => setTimeout(r, 120));
    const [record] = tracker.attribute([]);
    expect(record?.type).toBe("save button");
    expect(record?.durationMs).toBeGreaterThanOrEqual(5);
  });

  it("still records when the action throws, and rethrows", async () => {
    const tracker = new InteractionTracker();
    expect(() =>
      tracker.measure("exploding", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const [record] = tracker.attribute([]);
    expect(record?.type).toBe("exploding");
  });
});

describe("throttled measurement windows", () => {
  it("does not attribute idle time to the app", () => {
    const tracker = new InteractionTracker();
    // A hidden or throttled tab stretches the wait for a frame: the handler took
    // 4ms, rendering took 12ms, and the window closed 900ms later.
    tracker.record({ name: "click", startTime: 0, duration: 900, handlerMs: 4 });
    const [record] = tracker.attribute([
      event({ name: "Table", commitTime: 5, selfDuration: 12 }),
    ]);

    const summary = summarise(record as never);
    expect(summary.headline).toContain("waiting for a frame");
    expect(summary.headline).toContain("ignore it");
    // It must not claim 900ms of anything.
    expect(summary.nextStep).not.toContain("900");
  });

  it("still reports an honestly slow interaction", () => {
    const tracker = new InteractionTracker();
    tracker.record({ name: "click", startTime: 0, duration: 300, handlerMs: 280 });
    const [record] = tracker.attribute([event({ name: "Table", commitTime: 5, selfDuration: 10 })]);
    const summary = summarise(record as never);
    expect(summary.headline).not.toContain("waiting for a frame");
  });
});
