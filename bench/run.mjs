#!/usr/bin/env node
/**
 * Instrumentation overhead benchmark (§38).
 *
 * Runs against the built `dist/` — the artifact users install. jsdom is not a
 * browser, so read these as relative numbers: identical workloads with and
 * without instrumentation, interleaved in one process to blunt warm-up drift.
 *
 * Four arms, because "overhead" is two different costs:
 *
 *   baseline      the app as written
 *   structural    wrapped, detective disabled — the cost of the extra element
 *   default       wrapped and recording, depth-1 inspection
 *   deep          wrapped and recording, depth-3 inspection + function source
 */
import { JSDOM } from "jsdom";
import { createElement as h } from "react";

const dom = new JSDOM("<!doctype html><div id=root></div>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const rrd = await import("../dist/index.js");

const UPDATES = 20;
const REPEATS = 7;

/** A leaf that does a little real work, so the ratio means something. */
function Leaf({ value, style, label }) {
  const text = `${label}: ${value.toFixed(2)}`;
  return h("span", { style, title: text }, h("b", null, label), " ", text);
}

const TrackedLeaf = rrd.withRenderDetective(Leaf, { name: "Leaf" });

function makeTree(Component, count) {
  return function Tree({ tick }) {
    const children = new Array(count);
    for (let i = 0; i < count; i++) {
      children[i] = h(Component, {
        key: i,
        value: (tick + i) % 7,
        label: `row-${i}`,
        style: { color: i % 2 ? "red" : "blue" },
      });
    }
    return h("div", null, children);
  };
}

function run(Component, count) {
  return runTree(makeTree(Component, count));
}

function runTree(Tree) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => root.render(h(Tree, { tick: 0 })));
  const start = performance.now();
  for (let i = 1; i <= UPDATES; i++) act(() => root.render(h(Tree, { tick: i })));
  const elapsed = performance.now() - start;

  act(() => root.unmount());
  container.remove();
  performance.clearMeasures?.();
  performance.clearMarks?.();
  return elapsed / UPDATES;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function compare(count, arms) {
  const samples = Object.fromEntries(Object.keys(arms).map((k) => [k, []]));
  for (let r = 0; r < REPEATS; r++) {
    for (const [name, arm] of Object.entries(arms)) {
      arm.setup?.();
      samples[name].push(run(arm.component, count));
    }
  }
  const base = median(samples.baseline);
  const rows = {};
  for (const name of Object.keys(arms)) {
    const value = median(samples[name]);
    rows[name] = { ms: value, overhead: ((value - base) / base) * 100, perComponent: ((value - base) / count) * 1000 };
  }
  return rows;
}

const arms = {
  baseline: { component: Leaf },
  structural: {
    component: TrackedLeaf,
    setup: () => {
      rrd.reset();
      rrd.init({ enabled: false });
    },
  },
  default: {
    component: TrackedLeaf,
    setup: () => {
      rrd.reset();
      rrd.init({ enabled: true, mode: "silent", maxEvents: 1000 });
    },
  },
  deep: {
    component: TrackedLeaf,
    setup: () => {
      rrd.reset();
      rrd.init({
        enabled: true,
        mode: "silent",
        maxEvents: 1000,
        inspection: { depth: 3 },
        compareFunctionSource: true,
      });
    },
  },
};

console.log("React Render Detective — instrumentation overhead");
console.log(`${UPDATES} full-tree updates per sample, median of ${REPEATS}, every component instrumented.\n`);
console.log(
  `${"components".padStart(10)}  ${"baseline".padStart(9)}  ${"structural".padStart(20)}  ${"default".padStart(20)}  ${"deep".padStart(20)}`,
);

const summary = [];
for (const count of [100, 1000, 5000]) {
  const r = compare(count, arms);
  summary.push({ count, ...r });
  const cell = (x) => `${x.ms.toFixed(2)}ms ${sign(x.overhead)}`.padStart(20);
  console.log(
    `${String(count).padStart(10)}  ${`${r.baseline.ms.toFixed(2)}ms`.padStart(9)}  ${cell(r.structural)}  ${cell(r.default)}  ${cell(r.deep)}`,
  );
}

console.log("\nPer-instrumented-component cost, default mode:");
for (const row of summary) {
  console.log(
    `  ${String(row.count).padStart(5)} components   structural ${row.structural.perComponent.toFixed(2)}µs   ` +
      `recording ${(row.default.perComponent - row.structural.perComponent).toFixed(2)}µs   ` +
      `total ${row.default.perComponent.toFixed(2)}µs`,
  );
}

// Realistic usage: you instrument the components under investigation, not all
// 2000. Both arms render the identical tree; only the wrapper differs.
console.log("\nRealistic usage — same 2000-component tree, N of them instrumented:");
{
  const count = 2000;
  for (const share of [0.02, 0.1, 0.5]) {
    const every = Math.round(1 / share);
    const Mixed = makeTree(Leaf, count);
    const MixedTracked = function Tree({ tick }) {
      const children = new Array(count);
      for (let i = 0; i < count; i++) {
        const Component = i % every === 0 ? TrackedLeaf : Leaf;
        children[i] = h(Component, {
          key: i,
          value: (tick + i) % 7,
          label: `row-${i}`,
          style: { color: i % 2 ? "red" : "blue" },
        });
      }
      return h("div", null, children);
    };

    rrd.reset();
    rrd.init({ enabled: true, mode: "silent", maxEvents: 1000 });
    const baseSamples = [];
    const mixedSamples = [];
    for (let r = 0; r < REPEATS; r++) {
      baseSamples.push(runTree(Mixed));
      mixedSamples.push(runTree(MixedTracked));
    }
    const base = median(baseSamples);
    const mixed = median(mixedSamples);
    console.log(
      `  ${String(Math.round(count * share)).padStart(4)} of ${count} instrumented (${(share * 100).toFixed(0)}%)   ` +
        `baseline ${base.toFixed(2)}ms   instrumented ${mixed.toFixed(2)}ms   ${sign(((mixed - base) / base) * 100)}`,
    );
  }
}

// Bounded memory. Measured without React so the number is our retention, not
// jsdom's garbage: same event volume, two buffer sizes.
console.log("\nMemory — 200,000 render events recorded directly:");
{
  const { getDetective } = await import("../dist/core.js");
  for (const maxEvents of [1000, 50_000]) {
    rrd.reset();
    rrd.init({ enabled: true, mode: "silent", maxEvents });
    const d = getDetective();
    const node = d.createNode("Bench", undefined);
    d.attach(node);
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 200_000; i++) {
      d.recordAttempt(node, { i, style: { color: "red" }, label: `row-${i}` });
      d.recordCommit(node, {
        phase: i === 0 ? "mount" : "update",
        subtreeDuration: 1,
        baseDuration: 1,
        startTime: i,
        commitTime: i,
      });
      if (i % 500 === 0) d.flush();
    }
    d.flush();
    globalThis.gc?.();
    const after = process.memoryUsage().heapUsed;
    console.log(
      `  maxEvents ${String(maxEvents).padStart(6)}   heap +${((after - before) / 1024 / 1024).toFixed(1)} MB   ` +
        `${d.getEvents().length} events retained   ${d.getComponentStats("Bench")[0]?.renderCount} renders counted`,
    );
  }
}

function sign(pct) {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}


