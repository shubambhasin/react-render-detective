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
