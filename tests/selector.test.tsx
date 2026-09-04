import { useSyncExternalStore } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedSelectorHook, getEvents, init, withRenderDetective } from "../src/index.js";
import type { RenderEvent } from "../src/index.js";

afterEach(cleanup);

const track = <P extends object>(name: string, C: React.ComponentType<P>) => withRenderDetective(C, { name });

/** A minimal Redux-shaped store: subscribe + getSnapshot, like react-redux uses. */
function createStore<S>(initial: S) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(next: S) {
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const store = createStore({ flights: { results: [1, 2, 3], query: "" }, user: { id: 1 } });

/**
 * Stands in for react-redux's useSelector.
 *
 * The selector runs during render over a stable state snapshot — which is the
 * shape that makes the unstable-selector bug observable. Passing the selector
 * result straight to `getSnapshot` instead would make React loop, by design:
 * a snapshot must be cached.
 */
function useSelector<T>(selector: (s: ReturnType<typeof store.getState>) => T): T {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return selector(state);
}

const lastFor = (name: string): RenderEvent | undefined =>
  getEvents().filter((e) => e.component.name === name).at(-1);

describe("external store attribution", () => {
  it("names the selector behind a store-driven render", () => {
    init({ enabled: true, mode: "silent" });
    const tracked = createTrackedSelectorHook(useSelector, { name: "flights.query", source: "src/Panel.tsx:12:3" });

    const Panel = track("QueryPanel", function QueryPanel() {
      const query = tracked((s) => s.flights.query);
      return <i>{query}</i>;
    });

    render(<Panel />);
    act(() => store.setState({ ...store.getState(), flights: { ...store.getState().flights, query: "delhi" } }));

    const event = lastFor("QueryPanel") as RenderEvent;
    // Previously this could only ever be "state-or-external".
    expect(event.diagnosis.reason).toBe("store");
    expect(event.diagnosis.confidence).toBe("high");
    expect(event.selectorChanges[0]?.name).toBe("flights.query");
    expect(event.diagnosis.summary).toContain("flights.query");
    expect(event.diagnosis.potentiallyAvoidable).toBe(false); // the value really changed
  });

  it("catches a selector that builds a new value every call", () => {
    init({ enabled: true, mode: "silent" });
    const tracked = createTrackedSelectorHook(useSelector, { name: "flights.visible", source: "src/List.tsx:8:3" });

    const List = track("VisibleList", function VisibleList() {
      // The classic Redux bug: a new array on every call, so useSelector's
      // Object.is check always fails and this re-renders on every store update —
      // including ones that changed nothing it reads.
      const visible = tracked((s) => s.flights.results.filter(Boolean));
      return <i>{visible.length}</i>;
    });

    render(<List />);
    act(() => store.setState({ ...store.getState(), user: { id: 2 } }));

    const event = lastFor("VisibleList") as RenderEvent;
    expect(event.diagnosis.reason).toBe("store");
    expect(event.selectorChanges[0]?.referenceOnly).toBe(true);
    expect(event.diagnosis.potentiallyAvoidable).toBe(true);
    expect(event.diagnosis.summary).toContain("new reference with identical contents");
    expect(event.diagnosis.suggestion).toContain("createSelector");
    expect(event.diagnosis.suggestion).toContain("src/List.tsx:8:3");
    expect(event.diagnosis.evidence.join(" ")).toContain("Object.is");
  });

  it("returns the store value untouched and passes extra arguments through", () => {
    init({ enabled: true, mode: "silent" });
    const seen: unknown[][] = [];
    const raw = (...args: unknown[]) => {
      seen.push(args);
      return { id: 7 };
    };
    const tracked = createTrackedSelectorHook(raw as (...a: unknown[]) => { id: number });

    const Solo = track("PassThrough", function PassThrough() {
      const value = tracked((s: unknown) => s, "equalityFn");
      return <i>{value.id}</i>;
    });
    render(<Solo />);

    // Behaviour must be identical with or without tracking.
    expect(seen[0]).toHaveLength(2);
    expect(seen[0]?.[1]).toBe("equalityFn");
  });

  it("does not let a selector in an uninstrumented child blame its ancestor", () => {
    init({ enabled: true, mode: "silent" });
    const tracked = createTrackedSelectorHook(useSelector, { name: "user.id" });

    function UnwrappedChild() {
      const id = tracked((s) => s.user.id);
      return <i>{id}</i>;
    }
    const Host = track("SelectorHost", function SelectorHost() {
      const own = tracked((s) => s.flights.query);
      return (
        <div>
          <span>{own}</span>
          <UnwrappedChild />
        </div>
      );
    });

    render(<Host />);
    act(() => store.setState({ ...store.getState(), user: { id: 99 } }));

    const event = lastFor("SelectorHost") as RenderEvent;
    // The child's selector is not the host's; only the host's own may be reported.
    expect(event.selectorChanges.every((c) => c.name !== "user.id")).toBe(true);
  });
});

describe("explain and ranking for store-driven components", () => {
  it("does not claim the cause is undetermined when it is a selector", async () => {
    // The store reason had no branch in explain(), so a component whose renders
    // were entirely store-driven was reported as "could not be determined
    // reliably" — the opposite of the truth, since store is the highest
    // confidence diagnosis produced.
    const { explain, explainStructured, getEvents: readEvents, rankOpportunities } = await import("../src/index.js");
    init({ enabled: true, mode: "silent" });
    const tracked = createTrackedSelectorHook(useSelector, { name: "flights.derived", source: "src/D.tsx:4:1" });

    const Derived = track("DerivedList", function DerivedList() {
      const rows = tracked((s) => s.flights.results.map((n) => n * 2));
      return <i>{rows.length}</i>;
    });

    render(<Derived />);
    for (let i = 0; i < 4; i++) {
      act(() => store.setState({ ...store.getState(), user: { id: 100 + i } }));
    }

    const structured = explainStructured("DerivedList");
    expect(structured?.unstableSelectors[0]?.name).toBe("flights.derived");
    expect(structured?.confidence).toBe("high");

    const text = explain("DerivedList") as string;
    expect(text).not.toContain("could not be determined reliably");
    expect(text).toContain("flights.derived");
    expect(text).toContain("every store update");
    expect(text).toContain("src/D.tsx:4:1");

    /*
     * The ranking must carry the same advice rather than inheriting the old
     * fallback. `minSavingMs: 0` because these test renders cost fractions of a
     * millisecond, and the default noise floor correctly excludes them —
     * getOpportunities() filtering this out is right, not a bug.
     */
    const ranked = rankOpportunities({
      events: readEvents(),
      lifecycles: new Map(),
      minSavingMs: 0,
    });
    const top = ranked.find((o) => o.component === "DerivedList");
    expect(top).toBeDefined();
    expect(top?.nextStep).toContain("createSelector");
  });
});
