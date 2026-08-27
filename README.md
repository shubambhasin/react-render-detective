# React Render Detective

[![npm](https://img.shields.io/npm/v/react-render-detective?color=2f6df6)](https://www.npmjs.com/package/react-render-detective)
[![bundle](https://img.shields.io/badge/gzip-12.4%20KB-2f6df6)](docs/BUNDLE-SIZE.md)
[![deps](https://img.shields.io/badge/runtime%20deps-0-2f6df6)](package.json)
[![license](https://img.shields.io/npm/l/react-render-detective)](LICENSE)

**Know *why* your React components render.**

📖 **[Website](https://shubambhasin.github.io/react-render-detective/)** ·
[Guide](docs/GUIDE.md) · [API](docs/API.md) · [Feasibility report](docs/FEASIBILITY.md) ·
[Benchmarks](docs/BENCHMARKS.md)

> **Status: 0.1.0, early release.** 74 tests pass on React 18 and 19, benchmarks and bundle budgets
> are green, and the packed package is verified in a clean install for ESM, CJS and TypeScript
> consumers. Not yet exercised: a real browser (all testing is jsdom) and Suspense / error-boundary
> edges. Treat it as a preview — issues welcome.

Not just:

```text
UserProfile rendered 47 times.
```

But:

```text
UserProfile rendered because `user` changed by reference.
Its values are identical. Dashboard recreated the object.
```

Debug React rendering without scattering `console.log` through your components.

---

## Install

```bash
npm install react-render-detective
```

```tsx
import { init } from "react-render-detective";

if (process.env.NODE_ENV !== "production") {
  init();
}
```

Then wrap the components you're investigating:

```tsx
import { withRenderDetective } from "react-render-detective";

const UserProfile = withRenderDetective(function UserProfile({ user, onSave }) {
  return /* … */;
});
```

That's it. No server, no account, no API key, no browser extension, no data leaves your machine.

```text
▲ [RRD] UserProfile #47  Reason: prop changed (reference only)  Changed: user  Duration: 8.4ms
```

Ask for the whole story at any time:

```ts
import { explain } from "react-render-detective";
console.log(explain("UserProfile"));
```

```text
UserProfile

47 recorded renders

Why?
  78% of renders followed `user` changing by reference while its contents stayed the same.

Breakdown
  props                  37  79%
  parent                  8  17%
  mount                   1   2%
  state-or-external       1   2%

Reference-only prop changes
  user                   37  79%  (object)
  onSave                 31  66%  (function)

Cost
  average       8.4ms
  total         394.8ms
  potentially avoidable  37 render(s), ~310.8ms

Next step
  Find where `user` is created in Dashboard and stabilise it (useMemo, or pass the
  primitive fields you use).

Confidence: high
```

---

## What makes this different

It answers **causality**, not counts:

| Question | Answer |
| --- | --- |
| What rendered? | component, render number, mount vs update |
| Why? | props · parent · context · state · external store — with the evidence |
| What changed? | per prop: value change vs *reference-only* change |
| Where from? | the nearest instrumented ancestor, and whether it re-rendered |
| How expensive? | subtree duration, and self duration with descendants subtracted |
| How sure are we? | every diagnosis carries `high` / `medium` / `low` |
| What next? | an evidence-based suggestion, or nothing |

And it refuses to guess. When the runtime cannot tell you why something rendered, it says:

```text
Cause could not be determined reliably.
```

Three rules it holds to, which most render-debugging advice does not:

1. **Rendering is not a bug.** Output says *render*, *potentially avoidable render*, *slow render* —
   never "BAD RENDER".
2. **Memoization is a trade.** `React.memo` / `useMemo` / `useCallback` are suggested only when the
   evidence supports them, with the cost shown so you can decide.
3. **StrictMode is not a 2× regression.** Double-invoked renders are labelled as development
   replays and excluded from every statistic.

---

## Integration modes

### `withRenderDetective` — most accurate

```tsx
const UserProfile = withRenderDetective(UserProfileImpl, { name: "UserProfile" });
```

Full diagnosis: per-prop diffing, parent attribution, Profiler timings.

### `<RenderDetective>` — zero refactor

```tsx
<RenderDetective name="UserProfile">
  <UserProfile />
</RenderDetective>
```

Timings and parent propagation, but it only sees the `children` element — it cannot attribute a
render to an individual prop.

### `useRenderDiagnostics` — from inside

```tsx
function UserProfile(props) {
  const diagnostics = useRenderDiagnostics("UserProfile", props);
  // …
}
```

Catches state-driven renders too, but a hook cannot install a `<Profiler>` around its own
component, so **no durations** are available in this mode.

### Naming what the runtime can't see

```tsx
const [items, setItems] = useTrackedState("items", []);       // proves a state-driven render
useTrackedContextValue("AuthContext", value);                  // inside your provider
useTrackedEffect("sync", () => { … }, [userId]);               // which declared dep changed
```

---

## Overlay

```tsx
if (process.env.NODE_ENV !== "production") {
  const { mountOverlay } = await import("react-render-detective/overlay");
  mountOverlay();
}
```

A floating panel with live totals, the most expensive components, and the full `explain()` output
for whichever one you select. It renders in a shadow DOM outside your React tree — an inspector
that re-rendered the tree it measures would be measuring itself.

The overlay is optional and lazily imported; the core is fully usable from the console.

---

## Configuration

```ts
init({
  enabled: process.env.NODE_ENV !== "production",
  mode: "console",              // "silent" | "console" | "verbose"
  include: [/^Dashboard/],      // empty = everything
  exclude: ["Icon", "Button"],  // exclude wins over include
  samplingRate: 1,              // 0–1, decided once per component instance
  maxEvents: 1000,              // bounded ring buffer
  slowRenderThreshold: 16,
  thresholds: { monitor: 5, slow: 16, verySlow: 50, critical: 100 },
  inspection: { depth: 1, maxObjectKeys: 20, maxArrayLength: 20, maxStringLength: 120 },
  compareFunctionSource: false, // spot recreated inline closures (opt-in)
  onEvent: (event) => {},
});
```

`init()` is idempotent — Fast Refresh, duplicate module copies and repeated calls reconfigure the
single instance instead of stacking three copies of the debugger.

Full API: [docs/API.md](docs/API.md).

---

## Safety

- **Nothing leaves your machine.** No network calls, no telemetry, no analytics, no storage.
- **Production-safe by default.** `detectDev()` defaults to *off* when it cannot tell.
  With `enabled: false` nothing is registered and no `<Profiler>` is mounted.
- **Fail-safe.** Every instrumentation path is wrapped: a throwing getter, an exploding subscriber
  or an un-inspectable prop degrades the diagnostic, never your app.
- **Bounded.** Ring-buffered events, capped inspection depth/width, props released on unmount.

---

## Cost

Measured against the built package (`npm run bench`, full numbers in
[docs/BENCHMARKS.md](docs/BENCHMARKS.md)):

| | |
| --- | --- |
| Per instrumented component | ~7µs structural + ~7–16µs recording, well inside the 0.1ms target |
| Bundle, everything loaded | **12.4 KB gzip** (core 7.3 · React integration 10.7 · overlay 10.1) |
| Runtime dependencies | **none** |

Percentage overhead depends on what you instrument: wrapping every trivial leaf in a 5000-node
tree is expensive, wrapping the twenty components you're investigating is not. The benchmark
reports both, honestly.

---

## Limitations

Read [docs/FEASIBILITY.md](docs/FEASIBILITY.md) — it classifies every feature as reliable,
inferred, or impossible without React internals, and this package uses **no private React APIs**.

The headlines:

- **Parent** means *nearest instrumented ancestor*. Uninstrumented components in between are
  reported as such, not glossed over.
- **Context** subscriptions are not enumerable at runtime. Context-driven renders are correlation
  within one commit, reported at medium confidence, and only for contexts you track.
- **State values** are not readable without internals. An untracked state render is reported as
  `state-or-external` — we say we cannot tell which, rather than guessing.
- **`useTrackedState` must be called in an instrumented component.** A hook cannot see its own
  caller, only the nearest instrumented ancestor.
- **Source locations** need a build-time transform (`_debugSource` was removed in React 19), so
  they are not in v1.
- **Self duration** is an upper bound: React exposes subtree time, and we subtract the instrumented
  descendants we know about.

---

## React support

React 16.9+ (`Profiler`, context, refs — all public API). Tested against React 18 and 19; see
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the one behavioural difference between them.

## License

MIT
