#!/usr/bin/env node
/**
 * Before/after: does acting on the tool's advice actually pay off?
 *
 * The project could describe problems long before it could show that fixing one
 * helps. This drives an identical interaction against two versions of the same
 * UI — one carrying the anti-patterns the tool reports, one with them fixed —
 * and records what changed.
 *
 * Deliberately not a micro-benchmark. It counts **renders, remounts and render
 * time for a scripted interaction**, which is what the tool claims to reduce.
 * Timings in jsdom are indicative; the render and remount counts are exact.
 */
import { JSDOM } from "jsdom";
import { createElement as h, memo, useCallback, useMemo, useState } from "react";

const dom = new JSDOM("<!doctype html><div id=root></div>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const rrd = await import("../dist/index.js");

const ROWS = 40;
const INTERACTIONS = 10;

/** A memoized row. Whether `memo` can actually hold is what the fix decides. */
const Row = memo(
  rrd.withRenderDetective(
    function Row({ item, onSelect }) {
      return h("li", { onClick: () => onSelect(item.id) }, `${item.name} ${item.price}`);
    },
    { name: "Row" },
  ),
);

const Table = rrd.withRenderDetective(
  function Table({ rows, onSelect }) {
    return h("ul", null, rows.map((item) => h(Row, { key: item.id, item, onSelect })));
  },
  { name: "Table" },
);

const ITEMS = Array.from({ length: ROWS }, (_, i) => ({ id: i, name: `Item ${i}`, price: i * 3 }));

/**
 * Before: three things the tool reports, all real and all common.
 *   1. `onSelect` recreated every render, so `memo` on Row never holds
 *   2. `rows` rebuilt every render, same contents, new reference
 *   3. `Badge` declared inside the render body, so it is rebuilt not re-rendered
 */
const Before = rrd.withRenderDetective(
  function Screen() {
    const [tick, setTick] = useState(0);
    /*
     * Wrapped in the render body, which is exactly what the build plugin emits
     * for a component declared here. Without this the inline Badge is invisible
     * and the "before" column understates itself — its remounts would not be
     * counted at all, which would flatter the comparison.
     */
    const Badge = rrd.withRenderDetective(({ n }) => h("span", null, `${n} items`), {
      name: "Badge",
      declaredInRender: true,
    });
    const rows = ITEMS.filter((i) => i.price >= 0);
    const onSelect = (id) => void id;
    return h(
      "div",
      null,
      h("button", { onClick: () => setTick(tick + 1) }, `tick ${tick}`),
      h(Badge, { n: rows.length }),
      h(Table, { rows, onSelect }),
    );
  },
  { name: "Screen" },
);

/** After: the same UI, with exactly the changes the tool suggests. */
const Badge = rrd.withRenderDetective(function Badge({ n }) {
  return h("span", null, `${n} items`);
}, { name: "Badge" });

const After = rrd.withRenderDetective(
  function Screen() {
    const [tick, setTick] = useState(0);
    const rows = useMemo(() => ITEMS.filter((i) => i.price >= 0), []);
    const onSelect = useCallback((id) => void id, []);
    return h(
      "div",
      null,
      h("button", { onClick: () => setTick(tick + 1) }, `tick ${tick}`),
      h(Badge, { n: rows.length }),
      h(Table, { rows, onSelect }),
    );
  },
  { name: "Screen" },
);

function run(Component) {
  rrd.reset();
  rrd.init({ enabled: true, mode: "silent", maxEvents: 20_000 });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => root.render(h(Component)));
  rrd.clear(); // measure the interaction, not the mount

  const start = performance.now();
  for (let i = 0; i < INTERACTIONS; i++) {
    act(() => container.querySelector("button").click());
  }
  const elapsed = performance.now() - start;

  const profile = rrd.getRenderProfile("tick the counter");
  const stats = rrd.getStats();

  act(() => root.unmount());
  container.remove();

  return {
    renders: stats.totalRenders,
    avoidable: stats.potentiallyAvoidableRenders,
    renderTime: stats.totalRenderTime,
    wall: elapsed,
    remounts: Object.values(profile.components).reduce((a, c) => a + c.remounts, 0),
    components: profile.components,
  };
}

// Interleaved, and the median taken, so one slow sample cannot tell the story.
const samples = { before: [], after: [] };
for (let i = 0; i < 5; i++) {
  samples.before.push(run(Before));
  samples.after.push(run(After));
}
const median = (xs, key) => [...xs].sort((a, b) => a[key] - b[key])[Math.floor(xs.length / 2)][key];

const before = {
  renders: median(samples.before, "renders"),
  avoidable: median(samples.before, "avoidable"),
  remounts: median(samples.before, "remounts"),
  renderTime: median(samples.before, "renderTime"),
};
const after = {
  renders: median(samples.after, "renders"),
  avoidable: median(samples.after, "avoidable"),
  remounts: median(samples.after, "remounts"),
  renderTime: median(samples.after, "renderTime"),
};

const pct = (b, a) => (b === 0 ? "—" : `${Math.round(((b - a) / b) * 100)}% fewer`);

console.log(`Before / after — ${INTERACTIONS} interactions, ${ROWS}-row table, median of 5\n`);
console.log(`${"".padEnd(22)}${"before".padStart(10)}${"after".padStart(10)}${"change".padStart(16)}`);
for (const [label, key] of [
  ["renders", "renders"],
  ["potentially avoidable", "avoidable"],
  ["remounts", "remounts"],
]) {
  console.log(
    `${label.padEnd(22)}${String(before[key]).padStart(10)}${String(after[key]).padStart(10)}${pct(before[key], after[key]).padStart(16)}`,
  );
}
console.log(
  `${"render time".padEnd(22)}${`${before.renderTime.toFixed(1)}ms`.padStart(10)}${`${after.renderTime.toFixed(1)}ms`.padStart(10)}${pct(before.renderTime, after.renderTime).padStart(16)}`,
);

console.log("\nPer component (renders before → after):");
const names = new Set([...Object.keys(samples.before[0].components), ...Object.keys(samples.after[0].components)]);
for (const name of names) {
  const b = samples.before[0].components[name]?.renders ?? 0;
  const a = samples.after[0].components[name]?.renders ?? 0;
  console.log(`  ${name.padEnd(20)} ${String(b).padStart(5)} → ${String(a).padStart(5)}`);
}

if (after.renders >= before.renders) {
  console.error("\nThe fixes did not reduce renders. That is a result worth investigating, not hiding.");
  process.exit(1);
}
