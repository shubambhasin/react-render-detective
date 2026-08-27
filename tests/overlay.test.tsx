import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { init, RenderDetective, getEvents, withRenderDetective } from "../src/index.js";
import { mountOverlay } from "../src/overlay/overlay.js";

afterEach(cleanup);

describe("RenderDetective boundary", () => {
  it("tracks a subtree without touching the component inside it", () => {
    init({ enabled: true, mode: "silent" });
    function Inner() {
      return <p>inner</p>;
    }
    render(
      <RenderDetective name="Boundary">
        <Inner />
      </RenderDetective>,
    );
    const events = getEvents().filter((e) => e.component.name === "Boundary");
    expect(events).toHaveLength(1);
    expect(events[0]?.phase).toBe("mount");
  });
});

describe("overlay", () => {
  it("mounts outside the React tree, is idempotent, and tears down cleanly", () => {
    init({ enabled: true, mode: "silent" });
    const Solo = withRenderDetective(
      function Solo() {
        return <i>x</i>;
      },
      { name: "OverlaySubject" },
    );
    render(<Solo />);

    const overlay = mountOverlay();
    expect(mountOverlay()).toBe(overlay);

    const host = document.querySelector("[data-rrd-overlay]");
    expect(host).not.toBeNull();
    // Shadow DOM: nothing of the overlay leaks into the page's own DOM or React tree.
    expect(host?.shadowRoot?.querySelector("#panel")).not.toBeNull();
    expect(document.querySelector("#panel")).toBeNull();

    overlay.hide();
    overlay.show();
    overlay.destroy();
    expect(document.querySelector("[data-rrd-overlay]")).toBeNull();
  });
});

describe("privacy", () => {
  it("never performs a network request", () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
    const sendBeacon = vi.fn();
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = sendBeacon;

    init({ enabled: true, mode: "silent" });
    const Solo = withRenderDetective(
      function Solo({ n }: { n: number }) {
        return <i>{n}</i>;
      },
      { name: "PrivacySubject" },
    );
    const { rerender } = render(<Solo n={0} />);
    act(() => rerender(<Solo n={1} />));
    const overlay = mountOverlay();
    getEvents();
    overlay.destroy();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(sendBeacon).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
    xhrOpen.mockRestore();
  });

  it("stores nothing in localStorage or sessionStorage", () => {
    init({ enabled: true, mode: "silent" });
    const Solo = withRenderDetective(
      function Solo() {
        return <i>x</i>;
      },
      { name: "StorageSubject" },
    );
    render(<Solo />);
    getEvents();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
