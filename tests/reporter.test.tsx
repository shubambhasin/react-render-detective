import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEvents, init, withRenderDetective } from "../src/index.js";

afterEach(cleanup);

const track = <P extends object>(name: string, C: React.ComponentType<P>) => withRenderDetective(C, { name });
const flushBatch = async () => {
  getEvents();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 500));
  });
};

describe("console output at real-app scale", () => {
  it("says nothing when a list simply mounts", async () => {
    // The case that made this unusable: 20 rows × 10 tiles mounting produced
    // ~200 lines of "FareTile #1 mount 0.1ms". Mounting a list is not a defect.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    init({ enabled: true, mode: "console" });

    const Tile = track("Tile", function Tile({ n }: { n: number }) {
      return <i>{n}</i>;
    });
    const List = track("List", function List() {
      return (
        <ul>
          {Array.from({ length: 20 }, (_, i) => (
            <Tile key={i} n={i} />
          ))}
        </ul>
      );
    });

    render(<List />);
    await flushBatch();

    const rrdLines = [...log.mock.calls, ...warn.mock.calls].filter((c) => String(c[0]).includes("[RRD]"));
    expect(rrdLines).toHaveLength(0);
    log.mockRestore();
    warn.mockRestore();
  });

  it("reports one aggregated line per batch when something is actually wrong", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    init({ enabled: true, mode: "console" });

    const Row = track("Row", function Row(_: { onPick: () => void }) {
      return <i>row</i>;
    });
    const Host = track("Host", function Host() {
      const [tick, setTick] = useState(0);
      const onPick = () => {}; // recreated every render
      return (
        <div>
          <button onClick={() => setTick(tick + 1)}>go</button>
          {Array.from({ length: 12 }, (_, i) => (
            <Row key={i} onPick={onPick} />
          ))}
        </div>
      );
    });

    const { getByText } = render(<Host />);
    await flushBatch(); // let the mount batch drain so the assertion sees the click alone
    log.mockClear();
    act(() => void fireEvent.click(getByText("go")));
    await flushBatch();

    const rrdLines = log.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("[RRD]"));
    // One line for the whole burst, not twelve.
    expect(rrdLines).toHaveLength(1);
    const output = rrdLines[0] as string;
    expect(output).toContain("Row ×12");
    expect(output).toContain("props");
    expect(output).toContain("12 avoidable");
    expect(output).toContain("→");
    log.mockRestore();
  });

  it("keeps per-render detail in verbose mode", async () => {
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "groupEnd").mockImplementation(() => {});
    init({ enabled: true, mode: "verbose" });

    const Solo = track("VerboseSolo", function VerboseSolo({ n }: { n: number }) {
      return <i>{n}</i>;
    });
    const { rerender } = render(<Solo n={1} />);
    act(() => rerender(<Solo n={2} />));
    getEvents();

    expect(group.mock.calls.some((c) => String(c[0]).includes("VerboseSolo"))).toBe(true);
    vi.restoreAllMocks();
  });
});
