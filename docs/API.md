# API Reference

Everything is exported from the package root. `react-render-detective/core` is the React-free
subset (event model, comparison, diagnostic engine); `react-render-detective/overlay` is the
optional inspector.

## Setup

### `init(options?): void`

Enables diagnostics and attaches the console reporter. **Idempotent** — calling it again
reconfigures the single instance and re-attaches exactly one reporter.

`enabled` defaults to `true` unless `NODE_ENV === "production"` is positively detected: calling
`init()` *is* the intent to turn diagnostics on. Nothing is registered before that call, so
importing the package costs nothing. If the result is disabled, one line is logged to the console
so a disabled detective never looks like a broken one.

```ts
init({ enabled: process.env.NODE_ENV !== "production", mode: "console" });
```

### `configure(options): void`

Changes configuration without touching the reporter.

> `enabled` is read once per component instance, when it first renders, so the element tree never
> changes shape under a mounted component. Toggling it affects components mounted afterwards.

### `getConfig(): Readonly<DetectiveConfig>` · `isEnabled(): boolean`

### `reset(): void`

Full teardown: detaches the reporter, drops every node, listener and event, restores defaults.

## Instrumentation

### `withRenderDetective(Component, options?): ComponentType`

| option | type | meaning |
| --- | --- | --- |
| `name` | `string` | overrides the inferred name. Required for anonymous components, and recommended anywhere a bundler might rename duplicates. |

Most accurate mode: per-prop diffing, parent attribution, Profiler timings.

### `<RenderDetective name={string}>{children}</RenderDetective>`

Boundary form. Timings and parent propagation; no per-prop attribution.

### `useRenderDiagnostics(name, props?): RenderEvent | undefined`

In-component form. Returns the most recent completed event for this instance. No durations —
a hook cannot install a `Profiler` around its own component.

### `useTrackedState(name, initial): [S, Dispatch<SetStateAction<S>>]`

`useState` with a label. Turns a `state-or-external` diagnosis into a proven `state` one, naming
the value and showing its before/after.

> **Call it inside a component that is itself instrumented.** A hook cannot see which component
> called it — only the nearest instrumented ancestor. The first caller under a given node claims
> it, so a descendant cannot steal the attribution, but state named in an uninstrumented component
> whose ancestor tracks nothing would be reported against that ancestor. Wrap the component whose
> state you are naming.

### `useTrackedContextValue(contextName, value): T`

Call inside your provider. Records when the context value changes and which keys moved, and flags
a provider whose value is recreated every render.

### `useTrackedEffect(name, effect, deps): void`

`useEffect` that logs which of **its own declared** deps changed. It does not judge whether the
dependency list is correct — that needs static analysis, not runtime observation.

## Reading results

### `getEvents(): RenderEvent[]`

Oldest → newest, bounded by `maxEvents`.

### `getStats(): AppStats` · `getComponentStats(name?): ComponentStats[]`

Counts, totals, average/median/p95/p99/max self duration, slow renders, potentially avoidable
renders, and a per-reason breakdown.

### `explain(componentName): string | undefined`

The flagship answer, aggregated over recorded history: dominant cause, the props most often
changing by reference only, cost, estimated avoidable time, next step, confidence.

### `explainStructured(componentName): Explanation | undefined`

Same analysis as data.

### `subscribe(listener): () => void`

Live event stream. A throwing listener is contained and cannot break the pipeline.

### `printStats(): void` · `clear(): void`

## Overlay

```ts
const { mountOverlay } = await import("react-render-detective/overlay");
const overlay = mountOverlay();   // idempotent
overlay.hide(); overlay.show(); overlay.destroy();
```

## Types

```ts
type RenderReason =
  | "mount"
  | "props"
  | "parent"
  | "context"
  | "state"              // proven, via useTrackedState
  | "state-or-external"  // originated here; state vs store is not observable
  | "unknown";

type Confidence = "high" | "medium" | "low";

type PropChangeKind =
  | "added" | "removed"
  | "value"       // Object.is false and contents differ
  | "reference";  // Object.is false, bounded shallow compare found them identical

interface RenderEvent {
  id: string;
  component: ComponentInfo;
  timestamp: number;
  renderNumber: number;          // committed renders only
  phase: "mount" | "update" | "nested-update";
  timings: RenderTimings;
  changedProps: PropChange[];
  unchangedProps: string[];
  parent?: ComponentInfo;        // nearest *instrumented* ancestor
  parentRendered: boolean;
  selfOriginated: boolean;       // started here, not handed down from above
  contextChanges: ContextChange[];
  trackedState: TrackedStateChange[];
  committed: boolean;
  attempts: number;              // render-function invocations for this commit
  devReplay: boolean;            // attempts > 1: StrictMode or a discarded attempt
  diagnosis: Diagnosis;
}

interface RenderTimings {
  subtreeDuration: number;              // Profiler actualDuration — component + subtree
  baseDuration: number;                 // subtree cost without memoization
  selfDuration: number;                 // upper bound: subtree minus instrumented descendants
  accountedDescendantDuration: number;  // how much was subtracted
  commitTime: number;                   // shared by everything in one commit
  startTime: number;
}

interface Diagnosis {
  reason: RenderReason;
  confidence: Confidence;
  summary: string;
  evidence: string[];
  suggestion?: string;             // only when the evidence supports one
  potentiallyAvoidable: boolean;   // observable inputs did not change
  severity: "normal" | "monitor" | "slow" | "very-slow" | "critical";
}
```

`Inspected` values are bounded, cycle-safe snapshots — never live references to your data.
Render `Inspected` with `formatInspected()`.
