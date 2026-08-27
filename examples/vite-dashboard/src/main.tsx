import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { init } from "react-render-detective";
import { App } from "./App";
import "./styles.css";

if (import.meta.env.DEV) {
  init({
    mode: "console",
    slowRenderThreshold: 8,
    maxEvents: 2000,
  });

  // The overlay is optional and lazily imported — it never lands in a production bundle.
  void import("react-render-detective/overlay").then(({ mountOverlay }) => mountOverlay());

  // Handy from the browser console: rrd.explain("ProductTable")
  void import("react-render-detective").then((rrd) => {
    (window as unknown as { rrd: typeof rrd }).rrd = rrd;
  });
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
