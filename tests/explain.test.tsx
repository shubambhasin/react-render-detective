import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { explain, explainStructured, getStats, init, withRenderDetective } from "../src/index.js";

afterEach(cleanup);

describe("explain", () => {
  it("names the unstable prop behind the majority of a component's renders", () => {
    init({ enabled: true, mode: "silent" });

    const Row = withRenderDetective(
      function Row(_: { filters: { q: string } }) {
        return <li>row</li>;
      },
      { name: "ProductRow" },
    );

    const Page = withRenderDetective(
      function Page() {
        const [tick, setTick] = useState(0);
        const filters = { q: "" }; // recreated every render — the bug under test
        return (
          <div>
            <button onClick={() => setTick(tick + 1)}>tick</button>
            <Row filters={filters} />
          </div>
        );
      },
      { name: "ProductPage" },
    );

    const { getByText } = render(<Page />);
    for (let i = 0; i < 5; i++) act(() => void fireEvent.click(getByText("tick")));

    const structured = explainStructured("ProductRow");
    expect(structured?.unstableProps[0]?.key).toBe("filters");
    expect(structured?.confidence).toBe("high");
    expect(structured?.potentiallyAvoidableRenders).toBe(5);

    const text = explain("ProductRow") as string;
    expect(text).toContain("filters");
    expect(text).toContain("ProductPage");
    expect(text).toContain("of updates");
    // The nearest instrumented ancestor is where the prop *arrives* from, which
    // is not a claim about where it is created.
    expect(text).toContain("Trace `filters` back from ProductPage");
    expect(text).toContain("Confidence: high");
  });

  it("does not call a legitimate data change avoidable", () => {
    init({ enabled: true, mode: "silent" });
    const Label = withRenderDetective(
      function Label(_: { value: number }) {
        return <span>label</span>;
      },
      { name: "Label" },
    );
    const Host = withRenderDetective(
      function Host() {
        const [n, setN] = useState(0);
        return (
          <div>
            <button onClick={() => setN(n + 1)}>go</button>
            <Label value={n} />
          </div>
        );
      },
      { name: "Host" },
    );

    const { getByText } = render(<Host />);
    for (let i = 0; i < 3; i++) act(() => void fireEvent.click(getByText("go")));

    const structured = explainStructured("Label");
    expect(structured?.potentiallyAvoidableRenders).toBe(0);
    expect(structured?.headline).toContain("genuinely new values");
    expect(getStats().potentiallyAvoidableRenders).toBe(0);
  });

  it("returns undefined for a component it never saw", () => {
    init({ enabled: true, mode: "silent" });
    expect(explain("NeverRendered")).toBeUndefined();
  });
});

describe("explain honesty", () => {
  it("never calls reference-only changes 'new values', and excludes mounts from shares", () => {
    init({ enabled: true, mode: "silent" });

    const Row = withRenderDetective(
      function Row(_: { item: { id: number }; onSelect: () => void }) {
        return <li>row</li>;
      },
      { name: "HonestRow" },
    );

    const item = { id: 1 }; // stable — only the callback churns
    const List = withRenderDetective(
      function List() {
        const [tick, setTick] = useState(0);
        const onSelect = () => {}; // recreated every render
        return (
          <div>
            <button onClick={() => setTick(tick + 1)}>tick</button>
            {[0, 1, 2].map((i) => (
              <Row key={i} item={item} onSelect={onSelect} />
            ))}
          </div>
        );
      },
      { name: "HonestList" },
    );

    const { getByText } = render(<List />);
    for (let i = 0; i < 2; i++) act(() => void fireEvent.click(getByText("tick")));

    const e = explainStructured("HonestRow");
    expect(e).toBeDefined();
    expect(e?.mounts).toBe(3);
    // 3 rows × 2 updates = 6 updates, every one caused by `onSelect`.
    expect(e?.unstableProps[0]?.key).toBe("onSelect");
    expect(e?.unstableProps[0]?.share).toBe(1);

    const text = explain("HonestRow") as string;
    expect(text).not.toContain("genuinely new values");
    expect(text).toContain("onSelect");
    expect(text).toContain("(3 mounts)");
  });
});
