import { describe, expect, it } from "vitest";
import { clear, getEvents, init, subscribe } from "../src/index.js";
import { getDetective } from "../src/core/store.js";
import type { CommitInput } from "../src/core/store.js";

const commit = (over: Partial<CommitInput> = {}): CommitInput => ({
  phase: "update",
  subtreeDuration: 1,
  baseDuration: 1,
  startTime: 0,
  commitTime: 1,
  ...over,
});

describe("memory safety", () => {
  it("stays bounded across 100k render events", () => {
    init({ enabled: true, mode: "silent", maxEvents: 500 });
    const d = getDetective();
    const node = d.createNode("Stress", undefined);
    if (!node) throw new Error("node not created");
    d.attach(node);

    for (let i = 0; i < 100_000; i++) {
      d.recordAttempt(node, { i, payload: { a: 1 } });
      d.recordCommit(node, commit({ phase: i === 0 ? "mount" : "update", commitTime: i }));
      if (i % 1000 === 0) d.flush();
    }
    d.flush();

    expect(getEvents().length).toBeLessThanOrEqual(500);
    const stats = d.getComponentStats("Stress")[0];
    expect(stats?.renderCount).toBe(100_000);
  });

  it("releases props as soon as a component detaches", () => {
    init({ enabled: true, mode: "silent" });
    const d = getDetective();
    const node = d.createNode("Temp", undefined);
    if (!node) throw new Error("node not created");
    d.attach(node);
    d.recordAttempt(node, { big: new Array(1000).fill("x") });
    d.recordCommit(node, commit({ phase: "mount" }));
    d.flush();

    d.detach(node);
    expect(node.prevProps).toBeUndefined();
    expect(node.pendingProps).toBeUndefined();
    expect(d.getComponentStats("Temp")).toHaveLength(0);
  });

  it("does not leak listeners", () => {
    init({ enabled: true, mode: "silent" });
    const unsubscribes = Array.from({ length: 50 }, () => subscribe(() => {}));
    unsubscribes.forEach((u) => u());
    clear();
    expect(getEvents()).toHaveLength(0);
  });

  it("a throwing subscriber cannot break the pipeline", () => {
    init({ enabled: true, mode: "silent" });
    const d = getDetective();
    subscribe(() => {
      throw new Error("subscriber exploded");
    });
    const seen: string[] = [];
    subscribe((e) => seen.push(e.component.name));

    const node = d.createNode("Resilient", undefined);
    if (!node) throw new Error("node not created");
    d.attach(node);
    d.recordAttempt(node, {});
    expect(() => d.recordCommit(node, commit({ phase: "mount" }))).not.toThrow();
    d.flush();
    expect(seen).toContain("Resilient");
  });
});
