import { StrictMode, memo, useState } from "react";
import type { ComponentType } from "react";
import { act, render, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clear,
  getComponentStats,
  getEvents,
  init,
  useRenderDiagnostics,
  useTrackedContextValue,
  useTrackedState,
  withRenderDetective,
} from "../src/index.js";
import type { RenderEvent } from "../src/index.js";

afterEach(cleanup);

const setup = (options = {}) => init({ enabled: true, mode: "silent", ...options });

/**
 * Always pass an explicit name in tests: bundlers rename duplicate function
 * identifiers within a module (`Solo` → `Solo2`), which is exactly the case the
 * `name` option exists for.
 */
const track = <P extends object>(name: string, Component: ComponentType<P>) =>
  withRenderDetective(Component, { name });

const eventsFor = (name: string): RenderEvent[] =>
  getEvents().filter((e) => e.component.name === name);
const lastFor = (name: string): RenderEvent | undefined => eventsFor(name).at(-1);

// ---------------------------------------------------------------- fixtures

const Child = track("Child", function Child(_: { user: { id: number }; label?: string }) {
  return <div>child</div>;
});

describe("render causality", () => {
  it("attributes a render to the parent when nothing about the child changed", () => {
    setup();
    const user = { id: 1 };

    const Parent = track("Parent", function Parent() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button onClick={() => setTick((t) => t + 1)}>tick</button>
          <Child user={user} />
        </div>
      );
    });

    const { getByText } = render(<Parent />);
    act(() => void fireEvent.click(getByText("tick")));

    const child = lastFor("Child");
    expect(child?.diagnosis.reason).toBe("parent");
    expect(child?.diagnosis.confidence).toBe("high");
    expect(child?.parent?.name).toBe("Parent");
    expect(child?.parentRendered).toBe(true);
    expect(child?.diagnosis.potentiallyAvoidable).toBe(true);
    expect(child?.changedProps).toEqual([]);
  });

  it("identifies a prop that changed by reference only, and points at the parent", () => {
    setup();
    const Parent = track("Parent", function Parent() {
      const [, setTick] = useState(0);
      // Recreated on every render — the classic unstable object prop.
      const user = { id: 1 };
      return (
        <div>
          <button onClick={() => setTick((t) => t + 1)}>tick</button>
          <Child user={user} />
        </div>
      );
    });

    const { getByText } = render(<Parent />);
    act(() => void fireEvent.click(getByText("tick")));

    const child = lastFor("Child");
    expect(child?.diagnosis.reason).toBe("props");
    expect(child?.changedProps).toHaveLength(1);
    expect(child?.changedProps[0]?.key).toBe("user");
    expect(child?.changedProps[0]?.kind).toBe("reference");
    expect(child?.changedProps[0]?.shallowEqual).toBe(true);
    expect(child?.diagnosis.potentiallyAvoidable).toBe(true);
    expect(child?.diagnosis.suggestion).toContain("useMemo");
  });

  it("reports a genuine data change as a legitimate render", () => {
    setup();
    const Parent = track("Parent", function Parent() {
      const [id, setId] = useState(1);
      return (
        <div>
          <button onClick={() => setId((n) => n + 1)}>next</button>
          <Child user={{ id }} />
        </div>
      );
    });

    const { getByText } = render(<Parent />);
    act(() => void fireEvent.click(getByText("next")));

    const child = lastFor("Child");
    expect(child?.diagnosis.reason).toBe("props");
    expect(child?.changedProps[0]?.kind).toBe("value");
    expect(child?.diagnosis.potentiallyAvoidable).toBe(false);
    expect(child?.diagnosis.confidence).toBe("high");
  });

  it("records nothing for a memoized child that React skipped", () => {
    setup();
    const Memoized = memo(
      track("Memoized", function Memoized(_: { user: { id: number } }) {
        return <span>memo</span>;
      }),
    );
    const user = { id: 1 };
    const Parent = track("Parent", function Parent() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button onClick={() => setTick((t) => t + 1)}>tick</button>
          <Memoized user={user} />
        </div>
      );
    });

    const { getByText } = render(<Parent />);
    const before = eventsFor("Memoized").length;
    act(() => void fireEvent.click(getByText("tick")));

    expect(eventsFor("Memoized")).toHaveLength(before);
    expect(lastFor("Parent")?.renderNumber).toBe(2);
  });

  it("attributes a render to the component's own state when it is named", () => {
    setup();
    const Counter = track("Counter", function Counter() {
      const [count, setCount] = useTrackedState("count", 0);
      return <button onClick={() => setCount(count + 1)}>{count}</button>;
    });

    const { getByText } = render(<Counter />);
    act(() => void fireEvent.click(getByText("0")));

    const event = lastFor("Counter");
    expect(event?.diagnosis.reason).toBe("state");
    expect(event?.diagnosis.confidence).toBe("high");
    expect(event?.trackedState[0]?.name).toBe("count");
    expect(event?.diagnosis.summary).toContain("count");
  });

  it("falls back to state-or-external for untracked local state", () => {
    setup();
    const Counter = track("Counter", function Counter() {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount(count + 1)}>{count}</button>;
    });

    const { getByText } = render(<Counter />);
    act(() => void fireEvent.click(getByText("0")));

    const event = lastFor("Counter");
    expect(event?.diagnosis.reason).toBe("state-or-external");
    expect(event?.diagnosis.confidence).toBe("medium");
  });

  it("correlates a tracked context update with its consumers", () => {
    setup();
    const Consumer = track("Consumer", function Consumer() {
      return <span>consumer</span>;
    });

    const Provider = track("Provider", function Provider() {
      const [theme, setTheme] = useState("light");
      useTrackedContextValue("ThemeContext", { theme });
      return (
        <div>
          <button onClick={() => setTheme("dark")}>toggle</button>
          <Consumer />
        </div>
      );
    });

    const { getByText } = render(<Provider />);
    act(() => void fireEvent.click(getByText("toggle")));

    const consumer = lastFor("Consumer");
    // The parent re-rendered too, so parent propagation is the direct cause —
    // but the context change must be surfaced as the alternative explanation.
    expect(consumer?.contextChanges[0]?.contextName).toBe("ThemeContext");
    expect(consumer?.diagnosis.evidence.join(" ")).toContain("ThemeContext");
    expect(consumer?.diagnosis.confidence).toBe("medium");
  });

  it("separates a component's own cost from its subtree", () => {
    setup();
    const Leaf = track("Leaf", function Leaf() {
      return <i>leaf</i>;
    });
    const Branch = track("Branch", function Branch() {
      return (
        <div>
          <Leaf />
        </div>
      );
    });

    render(<Branch />);
    const branch = lastFor("Branch");
    expect(branch?.timings.subtreeDuration).toBeGreaterThanOrEqual(branch?.timings.selfDuration ?? 0);
    expect(branch?.timings.accountedDescendantDuration).toBeGreaterThanOrEqual(0);
  });
});

describe("StrictMode", () => {
  it("counts one render per commit and labels the extra invocation", () => {
    setup();
    const Solo = track("Solo", function Solo() {
      const [n, setN] = useState(0);
      return <button onClick={() => setN(n + 1)}>{n}</button>;
    });

    const { getByText } = render(
      <StrictMode>
        <Solo />
      </StrictMode>,
    );
    act(() => void fireEvent.click(getByText("0")));

    const events = eventsFor("Solo");
    // The invariant that matters on every React version: two commits (mount and
    // the click), not four, despite the render function running twice for each.
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.committed)).toBe(true);

    /*
     * Labelling the extra invocation depends on both passes landing on the same
     * instrumented node. React 19 re-runs the render function against the same
     * hook state, so `attempts` reaches 2 and the replay is named. React 18
     * discards the first pass's hook state, so the extra attempt is not
     * observable — the counts stay correct either way, we just cannot annotate
     * it. See docs/COMPATIBILITY.md.
     */
    const mount = events[0] as RenderEvent;
    if (mount.attempts > 1) {
      expect(mount.devReplay).toBe(true);
      expect(mount.diagnosis.evidence.join(" ")).toContain("Not production behaviour");
    } else {
      expect(mount.devReplay).toBe(false);
    }
  });
});

describe("StrictMode regression", () => {
  it("diffs the first update against the real mount props, not an empty object", () => {
    setup();
    const Leaf = track("StrictLeaf", function StrictLeaf(_: { item: { id: number }; onPick: () => void }) {
      return <i>leaf</i>;
    });
    const item = { id: 1 };
    const Host = track("StrictHost", function StrictHost() {
      const [tick, setTick] = useState(0);
      const onPick = () => {};
      return (
        <div>
          <button onClick={() => setTick(tick + 1)}>go</button>
          <Leaf item={item} onPick={onPick} />
        </div>
      );
    });

    const { getByText } = render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    act(() => void fireEvent.click(getByText("go")));

    const first = eventsFor("StrictLeaf")[1] as RenderEvent;
    /*
     * StrictMode runs effect cleanup then the effect again on mount. If that
     * cleanup discards the recorded props, this first update diffs against {}
     * and every prop looks newly added — including `item`, which never changed.
     */
    expect(first.changedProps.map((c) => c.kind)).not.toContain("added");
    expect(first.changedProps.map((c) => c.key)).toEqual(["onPick"]);
    expect(first.changedProps[0]?.kind).toBe("reference");
    expect(first.unchangedProps).toContain("item");
  });
});

describe("integration modes", () => {
  it("useRenderDiagnostics reports causality without a wrapper, and admits it has no timings", () => {
    setup();
    function Hooked({ value }: { value: number }) {
      const diagnostics = useRenderDiagnostics("Hooked", { value });
      return <span>{diagnostics?.renderNumber ?? 0}</span>;
    }

    const { rerender } = render(<Hooked value={1} />);
    act(() => rerender(<Hooked value={2} />));

    const event = lastFor("Hooked");
    expect(event?.diagnosis.reason).toBe("props");
    expect(event?.changedProps[0]?.key).toBe("value");
    expect(event?.timings.subtreeDuration).toBe(0);
  });
});

describe("lifecycle and configuration", () => {
  it("init is idempotent — three calls do not triple the output", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    init({ enabled: true, mode: "console" });
    init({ enabled: true, mode: "console" });
    init({ enabled: true, mode: "console" });

    const Solo = track("Solo", function Solo() {
      return <i>x</i>;
    });
    render(<Solo />);
    act(() => {
      getEvents();
    });

    const mine = log.mock.calls.filter((c) => String(c[0]).includes("[RRD] Solo"));
    expect(mine).toHaveLength(1);
    log.mockRestore();
  });

  it("stops tracking a component once it unmounts", () => {
    setup();
    const Solo = track("Solo", function Solo() {
      return <i>x</i>;
    });
    const { unmount } = render(<Solo />);
    expect(getComponentStats("Solo")).toHaveLength(1);
    unmount();
    expect(getComponentStats("Solo")).toHaveLength(0);
  });

  it("honours exclude and include filters", () => {
    setup({ exclude: ["Noisy"], include: [/^Interesting/] });
    const Noisy = track("Noisy", function Noisy() {
      return <i>n</i>;
    });
    const Interesting = track("InterestingThing", function InterestingThing() {
      return <i>i</i>;
    });
    const Other = track("Other", function Other() {
      return <i>o</i>;
    });
    render(
      <div>
        <Noisy />
        <Interesting />
        <Other />
      </div>,
    );

    expect(eventsFor("Noisy")).toHaveLength(0);
    expect(eventsFor("Other")).toHaveLength(0);
    expect(eventsFor("InterestingThing")).toHaveLength(1);
  });

  it("collects nothing at samplingRate 0", () => {
    setup({ samplingRate: 0 });
    const Solo = track("Solo", function Solo() {
      return <i>x</i>;
    });
    render(<Solo />);
    expect(getEvents()).toHaveLength(0);
  });

  it("does nothing at all when disabled", () => {
    init({ enabled: false });
    const Solo = track("Solo", function Solo() {
      return <i>x</i>;
    });
    render(<Solo />);
    expect(getEvents()).toHaveLength(0);
    expect(getComponentStats()).toHaveLength(0);
  });

  it("keeps event storage bounded", () => {
    setup({ maxEvents: 10 });
    const Solo = track("Solo", function Solo({ n }: { n: number }) {
      return <i>{n}</i>;
    });
    const { rerender } = render(<Solo n={0} />);
    for (let i = 1; i < 200; i++) act(() => rerender(<Solo n={i} />));
    expect(getEvents().length).toBeLessThanOrEqual(10);
  });

  it("clear() empties history without detaching instrumentation", () => {
    setup();
    const Solo = track("Solo", function Solo({ n }: { n: number }) {
      return <i>{n}</i>;
    });
    const { rerender } = render(<Solo n={0} />);
    act(() => rerender(<Solo n={1} />));
    expect(getEvents().length).toBeGreaterThan(0);
    clear();
    expect(getEvents()).toHaveLength(0);
    act(() => rerender(<Solo n={2} />));
    expect(getEvents().length).toBe(1);
  });

  it("survives a prop whose getter throws", () => {
    setup();
    const Solo = track("Solo", function Solo(_: { danger: unknown }) {
      return <i>x</i>;
    });
    const danger = {
      get boom(): never {
        throw new Error("nope");
      },
    };
    const { rerender } = render(<Solo danger={danger} />);
    expect(() => act(() => rerender(<Solo danger={{ ...{} }} />))).not.toThrow();
  });
});

describe("tracked state ownership", () => {
  it("attributes named state to the instrumented component that owns it", () => {
    setup();
    const Owner = track("Owner", function Owner() {
      const [n, setN] = useTrackedState("ownCount", 0);
      return <button onClick={() => setN(n + 1)}>own {n}</button>;
    });
    const { getByText } = render(<Owner />);
    act(() => void fireEvent.click(getByText("own 0")));

    const event = lastFor("Owner");
    expect(event?.diagnosis.reason).toBe("state");
    expect(event?.trackedState[0]?.name).toBe("ownCount");
  });

  it("does not let an uninstrumented descendant steal the ancestor's attribution", () => {
    setup();
    function UnwrappedChild() {
      const [n, setN] = useTrackedState("childCount", 0);
      return <button onClick={() => setN(n + 1)}>child {n}</button>;
    }
    const Host = track("Host", function Host() {
      const [n, setN] = useTrackedState("hostCount", 0);
      return (
        <div>
          <button onClick={() => setN(n + 1)}>host {n}</button>
          <UnwrappedChild />
        </div>
      );
    });

    const { getByText } = render(<Host />);
    act(() => void fireEvent.click(getByText("child 0")));

    const event = lastFor("Host");
    // The child's state is not Host's — Host must not claim it.
    expect(event?.trackedState).toEqual([]);
    expect(event?.diagnosis.reason).toBe("state-or-external");
    expect(event?.diagnosis.confidence).toBe("medium");
    expect(event?.diagnosis.evidence.join(" ")).toContain("uninstrumented descendant");
  });
});

describe("double wrapping", () => {
  it("returns the existing wrapper instead of nesting one inside itself", () => {
    setup();
    const Once = track("DoubleWrapped", function DoubleWrapped() {
      return <i>x</i>;
    });
    const Twice = withRenderDetective(Once, { name: "DoubleWrapped" });
    expect(Twice).toBe(Once);

    // The real failure this prevents: a wrapper rendering itself forever.
    expect(() => render(<Twice />)).not.toThrow();
    expect(eventsFor("DoubleWrapped")).toHaveLength(1);
  });
});

describe("remount detection", () => {
  it("catches a component defined inside a render body", () => {
    setup();
    const Host = track("InlineHost", function InlineHost() {
      const [tick, setTick] = useState(0);
      // The bug: a new component type on every render, so React discards and
      // rebuilds the entire subtree instead of updating it.
      const Inner = track("InlineChild", function InlineChild() {
        return <i>inner</i>;
      });
      return (
        <div>
          <button onClick={() => setTick(tick + 1)}>go</button>
          <Inner />
        </div>
      );
    });

    const { getByText } = render(<Host />);
    for (let i = 0; i < 4; i++) act(() => void fireEvent.click(getByText("go")));

    const stats = getComponentStats("InlineChild")[0];
    expect(stats?.remountCount).toBeGreaterThanOrEqual(3);

    const last = lastFor("InlineChild") as RenderEvent;
    expect(last.phase).toBe("mount");
    expect(last.diagnosis.confidence).toBe("high");
    expect(last.diagnosis.summary).toContain("rebuilt, not re-rendered");
    expect(last.diagnosis.suggestion).toContain("out of its parent's render body");
  });

  it("catches key churn, and does not blame the definition for it", () => {
    setup();
    const Row = track("KeyedRow", function KeyedRow() {
      return <i>row</i>;
    });
    const List = track("KeyedList", function KeyedList({ epoch }: { epoch: number }) {
      // A stable component, but a key that changes every render — React cannot
      // reuse the instance.
      return <Row key={`row-${epoch}`} />;
    });

    const { rerender } = render(<List epoch={0} />);
    for (let i = 1; i <= 4; i++) act(() => rerender(<List epoch={i} />));

    const stats = getComponentStats("KeyedRow")[0];
    expect(stats?.remountCount).toBeGreaterThanOrEqual(3);
    const last = lastFor("KeyedRow") as RenderEvent;
    expect(last.diagnosis.confidence).toBe("medium");
    expect(last.diagnosis.suggestion).toContain("`key`");
  });

  it("does not mistake StrictMode's simulated remount for a real one", () => {
    setup();
    const Solo = track("StrictRemount", function StrictRemount() {
      return <i>x</i>;
    });
    render(
      <StrictMode>
        <Solo />
      </StrictMode>,
    );
    // StrictMode mounts, unmounts and remounts every component on mount. It
    // reuses the same fiber, so it must not register as a remount.
    expect(getComponentStats("StrictRemount")[0]?.remountCount).toBe(0);
  });

  it("does not flag a list that legitimately grows and shrinks", () => {
    setup();
    const Item = track("ListItem", function ListItem({ id }: { id: number }) {
      return <li>{id}</li>;
    });
    const List = track("GrowingList", function GrowingList({ ids }: { ids: number[] }) {
      return (
        <ul>
          {ids.map((id) => (
            <Item key={id} id={id} />
          ))}
        </ul>
      );
    });

    const { rerender } = render(<List ids={[1, 2]} />);
    act(() => rerender(<List ids={[1, 2, 3]} />));
    act(() => rerender(<List ids={[1, 2]} />));
    act(() => rerender(<List ids={[1, 2, 3]} />));

    // Item 3 mounts, unmounts and mounts again — that is the list working, and
    // the count reflects it, but nothing is diagnosed as a defect until it
    // repeats.
    const last = lastFor("ListItem") as RenderEvent;
    expect(last.diagnosis.potentiallyAvoidable).toBe(false);
    expect(last.diagnosis.summary).not.toContain("rebuilt");
  });
});
