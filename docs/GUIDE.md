# Guide

1. [Quick start](#quick-start)
2. [Vite](#vite) · [Next.js](#nextjs) · [Webpack](#webpack) · [Remix](#remix) · [Create React App / other](#other-bundlers)
3. [Choosing an integration mode](#choosing-an-integration-mode)
4. [Console mode](#console-mode)
5. [Overlay mode](#overlay-mode)
6. [Filtering and sampling](#filtering-and-sampling)
7. [Reading a diagnosis](#reading-a-diagnosis)
8. [StrictMode and concurrent rendering](#strictmode-and-concurrent-rendering)
9. [Troubleshooting](#troubleshooting)
10. [Privacy](#privacy)
11. [FAQ](#faq)

---

## Quick start

```bash
npm install react-render-detective
```

```tsx
import { init } from "react-render-detective";
if (process.env.NODE_ENV !== "production") init();
```

Wrap something you suspect:

```tsx
const ProductTable = withRenderDetective(ProductTableImpl);
```

Interact with the app, then ask:

```ts
rrd.explain("ProductTable");
```

Target: useful output in under five minutes without reading the rest of this page.

---

## Automatic instrumentation (recommended)

Wrapping components by hand only tells you about components you already suspected. The build plugin
instruments **every** component in development, and attaches a real source location — which React
itself cannot provide at runtime, since `_debugSource` was removed in React 19.

### Vite

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
import { renderDetective } from "react-render-detective/vite";

export default defineConfig({
  plugins: [renderDetective(), react()],   // renderDetective first
});
```

It only applies to `vite serve`, so a production build never sees it.

### Babel — Next.js, webpack, Remix, CRA

```json
// .babelrc  (or babel.config.js)
{
  "plugins": ["react-render-detective/babel"]
}
```

For the **Next.js app router**, enable `clientOnly` so server components are left alone — they
never render on the client, and wrapping one in a hook-using HOC breaks the build:

```json
{ "plugins": [["react-render-detective/babel", { "clientOnly": true }]] }
```

Note that adding a Babel config to a Next project opts it out of SWC, which slows compilation. If
that matters more than whole-app coverage, instrument by hand instead.

### Options

| option | default | meaning |
| --- | --- | --- |
| `enabled` | `NODE_ENV !== "production"` | the plugin removes itself otherwise |
| `include` | all files | strings or regexes matched against the file path |
| `exclude` | none | applied after `include` |
| `clientOnly` | `false` | skip files without a `"use client"` directive |
| `importSource` | `"react-render-detective"` | where the runtime is imported from |
| `root` | `process.cwd()` | base for relative source locations |

`@babel/core` is an optional peer dependency. Vite's React plugin already provides it; otherwise
`npm i -D @babel/core`. None of it reaches the browser — the runtime keeps its zero-dependency
guarantee.

### What it does and does not touch

Instrumented: uppercase-named functions that return JSX, including arrow components and the
function inside `memo()` / `forwardRef()` — inside, so `memo` keeps comparing props before the
instrumentation runs.

Left alone: hooks and lowercase functions, functions that never return JSX, JSX returned from a
nested closure, anything already wrapped by hand, `node_modules`, and the detective's own runtime.

Function declarations are instrumented by reassignment rather than being rewritten to `const`,
because components are routinely used above their definition and a `const` would turn that into a
temporal dead zone error.

## Vite

```tsx
// src/main.tsx
import { init } from "react-render-detective";

if (import.meta.env.DEV) {
  init({ mode: "console" });
  void import("react-render-detective/overlay").then((m) => m.mountOverlay());
}
```

`import.meta.env.DEV` is statically replaced, so the whole block — including the dynamic import —
is dropped from the production bundle. The core never references `import.meta.env` itself, so it
stays bundler-agnostic.

A complete example lives in [`examples/vite-dashboard`](../examples/vite-dashboard).

## Next.js

Instrumentation is client-side; server components never render on the client, so there is nothing
to measure there.

```tsx
// app/render-detective.tsx
"use client";
import { useEffect } from "react";

export function RenderDetective() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    void import("react-render-detective").then((m) => m.init({ mode: "console" }));
    void import("react-render-detective/overlay").then((m) => m.mountOverlay());
  }, []);
  return null;
}
```

```tsx
// app/layout.tsx
import { RenderDetective } from "./render-detective";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {process.env.NODE_ENV !== "production" && <RenderDetective />}
        {children}
      </body>
    </html>
  );
}
```

`process.env.NODE_ENV` is inlined by Next's compiler, so the import is eliminated in production.

## Webpack

```js
// webpack.config.js
new webpack.DefinePlugin({ "process.env.NODE_ENV": JSON.stringify(mode) });
```

Then the standard `if (process.env.NODE_ENV !== "production") init();` guard is removed by the
minifier's dead-code elimination.

## Remix

Same as Next: initialise from a client-only effect in `root.tsx`, guarded on
`process.env.NODE_ENV`.

## Other bundlers

Rspack, Parcel and esbuild all handle a `process.env.NODE_ENV` guard.

Nothing is registered until you call `init()`. That call means "turn it on", so `enabled` defaults
to true unless a production build is **positively detected** (`NODE_ENV === "production"`). The
asymmetry is deliberate: in a Vite dev server there is no `process` in the browser at all, and the
earlier "is this dev?" test answered *no*, which meant the documented quick-start switched the tool
on and then silently recorded nothing. Production safety is the guard around the call — which is
also what lets a bundler drop the package entirely.

If `init()` ends up disabled it says so once on the console rather than going quiet.

---

## Choosing an integration mode

| | per-prop diagnosis | durations | catches own-state renders | refactor needed |
| --- | :-: | :-: | :-: | --- |
| `withRenderDetective` | ✅ | ✅ | ✅ | wrap the component |
| `<RenderDetective>` | ❌ | ✅ | ✅ | drop in a boundary |
| `useRenderDiagnostics` | ✅ | ❌ | ✅ | one hook call |

Start with `withRenderDetective` on the handful of components you suspect. Instrumenting
everything is supported but costs more than it tells you — see [BENCHMARKS.md](BENCHMARKS.md).

Add `useTrackedState` when a diagnosis says `state-or-external` and you want to know *which* state.

---

## Console mode

```ts
init({ mode: "console" });   // one line per render
init({ mode: "verbose" });   // grouped: cause, parent, cost, props, evidence, next step
init({ mode: "silent" });    // record only; read with getStats()/explain()
```

Concise output:

```text
▲ [RRD] UserProfile #47  Reason: prop changed (reference only)  Changed: user  Duration: 8.4ms
```

The leading glyph is severity: `·` normal · `•` monitor · `▲` slow · `▲▲` very slow · `■` critical.
Slow renders go through `console.warn` so they surface in a filtered console.

---

## Overlay mode

```ts
const { mountOverlay } = await import("react-render-detective/overlay");
mountOverlay();
```

Live totals, the most expensive components, and full `explain()` output for the selected one.
It renders in a shadow root **outside** your React tree, so it never adds a render to what it
measures. `mountOverlay()` is idempotent.

---

## Filtering and sampling

```ts
init({
  include: [/^Dashboard/, "ProductTable"],  // empty = everything
  exclude: ["Icon", "Button"],              // exclude wins over include
  samplingRate: 0.25,                       // decided once per component instance
  maxEvents: 1000,
});
```

Sampling is per **instance**, not per render, so a sampled component keeps a complete, coherent
history rather than a series of gaps that would break prop diffing.

---

## Reading a diagnosis

Every event answers five questions:

```text
UserCard rendered #38

WHY        Parent `UserList` rendered.
WHAT       `user` prop reference changed.
DETAIL     Previous and current values are shallow-equal.
COST       6.8ms
CONFIDENCE High
NEXT       Check where `user` is recreated in UserList.
```

Confidence is a claim about **evidence**, not about severity:

| | when |
| --- | --- |
| `high` | directly observed — a prop changed, the parent rendered, a named state update |
| `medium` | inferred by elimination or by correlation within one commit |
| `low` | too little is instrumented to rule out alternatives |

`potentiallyAvoidable` means *no observable input changed*. It never means "this render was wrong" —
it means it is worth looking at.

---

## StrictMode and concurrent rendering

React StrictMode double-invokes render functions in development. This tool counts **commits**, so
your numbers are not doubled; the extra invocation is reported as a development replay and shows up
in `printStats()` as its own line.

Concurrent renders that React discards never reach `onRender`. They are swept and counted as
uncommitted attempts, and are excluded from durations and averages.

---

## Troubleshooting

**No output at all.**
`isEnabled()` — if it is `false`, `NODE_ENV` was not set to something non-production. Pass
`enabled: true` explicitly.

**Components show as `Anonymous`, or as `Solo2`.**
The name is inferred from the function. Arrow components assigned to a `const` usually infer fine;
anonymous ones do not, and bundlers rename duplicate identifiers within a module. Pass
`{ name: "…" }`.

**A diagnosis says `unknown`.**
There is no instrumented ancestor, so parent propagation cannot be ruled out. Wrap the parent.

**A render is attributed to `state-or-external` but I know it was context.**
Context subscriptions are not observable. Call `useTrackedContextValue` inside the provider.

**The parent shown is not the real parent.**
It is the nearest *instrumented* ancestor. Uninstrumented components in between are reported as
such in the evidence.

**Every component reports mount only.**
Something is remounting them — an inline component definition inside a parent's render body, or a
changing `key`. That is itself the finding.

**`useTrackedState` names a value but it shows up on the wrong component.**
Wrap the component that owns the state with `withRenderDetective`. The hook can only see the
nearest instrumented ancestor, so naming state inside an uninstrumented component attributes it
upward. (A descendant cannot take attribution that another component already claimed.)

**Durations are all 0.**
You are in `useRenderDiagnostics` (hook) mode, which cannot install a `Profiler`. Use
`withRenderDetective` for timings.

---

## Privacy

No network requests. No telemetry. No analytics. No cookies. No storage. No external services.
Nothing is uploaded anywhere, ever. Everything stays in the page you are debugging.

Prop values are captured as **bounded snapshots** (depth, key count, array length and string length
all capped) and are never live references. Increasing `inspection.depth` captures more of your
data into the in-memory ring buffer — which still never leaves the browser.

---

## FAQ

**Does this replace React DevTools?**
No. DevTools shows you *that* something rendered and how long it took. This tells you *why*, with
the changed value and the evidence.

**Can I ship it to production?**
It is designed to be safe if you accidentally do — disabled by default when it cannot detect a dev
environment, no network access, everything bounded. But it is a development tool: keep it behind a
guard so your bundler removes it.

**Will it change how my app renders?**
It adds three fibers per wrapped component (wrapper, `Profiler`, ancestry provider). The ancestry
context value is deliberately stable, so it does not trigger extra renders or defeat `React.memo`.

**Why doesn't it just tell me to add `React.memo`?**
Because memoization is a trade, and most renders are fine. Suggestions appear when the evidence
supports them, with the cost included so you can decide.

**Why is my render cause "state-or-external" instead of the actual state?**
Hook state is not readable without React internals, which this package refuses to use. Name the
state with `useTrackedState` and it becomes a proven `state` diagnosis.
