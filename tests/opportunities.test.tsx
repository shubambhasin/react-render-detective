import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getOpportunities, init, withRenderDetective } from "../src/index.js";

afterEach(cleanup);

const track = <P extends object>(name: string, C: React.ComponentType<P>) => withRenderDetective(C, { name });

describe("opportunity ranking", () => {
  it("ranks by recoverable time, not by render count", () => {
    init({ enabled: true, mode: "silent" });

    // Renders constantly but costs nothing.
    const Cheap = track("CheapNoisy", function CheapNoisy(_: { data: { id: number } }) {
      return <i>cheap</i>;
    });
    // Renders less often but each one is expensive.
    const Costly = track("CostlyQuiet", function CostlyQuiet(_: { data: { id: number } }) {
      const start = performance.now();
      while (performance.now() - start < 4) {
        /* burn a few ms so the ranking has something real to weigh */
      }
      return <i>costly</i>;
    });

    const Host = track("RankHost", function RankHost() {
      const [tick, setTick] = useState(0);
      const data = { id: 1 }; // recreated on every render — both children are avoidable
      return (
        <div>
          <button onClick={() => setTick(tick + 1)}>go</button>
          <Cheap data={data} />
          {tick % 3 === 0 ? <Costly data={data} /> : null}
        </div>
      );
    });

    const { getByText } = render(<Host />);
    for (let i = 0; i < 6; i++) act(() => void fireEvent.click(getByText("go")));

    const ranked = getOpportunities();
    const cheap = ranked.find((o) => o.component === "CheapNoisy");
    const costly = ranked.find((o) => o.component === "CostlyQuiet");

    expect(costly).toBeDefined();
    // The expensive component must outrank the noisy one despite fewer renders.
    expect(costly!.estimatedSavingMs).toBeGreaterThan(cheap?.estimatedSavingMs ?? 0);
    expect(ranked[0]?.component).toBe("CostlyQuiet");
    expect(costly!.nextStep).toBeTruthy();
  });

  it("stays silent when there is nothing worth reporting", () => {
    init({ enabled: true, mode: "silent" });
    const Quiet = track("QuietComponent", function QuietComponent() {
      return <i>x</i>;
    });
    render(<Quiet />);
    // A single cheap mount is not an opportunity.
    expect(getOpportunities()).toEqual([]);
  });
});
