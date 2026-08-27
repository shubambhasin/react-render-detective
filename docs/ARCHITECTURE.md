# Architecture

```text
React (public APIs only)
        ↓  wrapper render body  →  attempts, props snapshot
        ↓  <Profiler onRender>  →  durations, commit identity
   Instrumentation                        (src/react)
        ↓  cheap, allocation-light, no analysis on the render path
   Raw commit records  ──── queueMicrotask ────►  Flush / normalizer   (src/core/store.ts)
                                                        ↓
                                                 Diagnostic engine     (src/core/diagnose.ts)
                                                        ↓
                                                    RenderEvent
                                                        ↓
                                   ┌────────────────────┴────────────────────┐
                                   ↓                                         ↓
                        Console reporter (src/console)              Overlay (src/overlay)
                                                                    explain() (src/core/explain.ts)
```

Nothing downstream of `RenderEvent` contains diagnostic logic. Console mode, the overlay and
`explain()` are three renderings of the same events, which is why the engine can be tested
without React at all (`tests/diagnose.test.ts` imports no React).

## The render path does almost nothing

During render we increment a counter and store a props reference. During commit we push one
record. Every comparison, serialization, attribution and diagnosis happens in a microtask after
the commit — off the critical path, and with the whole commit batch visible at once, which is what
makes parent attribution possible.

## Attribution: the part that is easy to get wrong

A naive implementation wraps components in a `Profiler` and counts callbacks. That is wrong twice
over:

1. A `Profiler` fires for **every ancestor** of the work, not just the component that rendered.
2. The wrapper's render function runs when the component's **props are re-evaluated from above** —
   *not* when the component re-renders from its own state.

So each commit record carries `attempts`, the number of wrapper renders, and the flush pass reads
it like this:

| `attempts` | meaning | how it is attributed |
| --- | --- | --- |
| `> 0` | something above re-rendered this component | `props` if a prop changed, else `parent` |
| `0`, and an instrumented child re-rendered from above | this component produced that child, so it rendered | `state` / `context` / `state-or-external`, **high** confidence |
| `0`, and no instrumented descendant committed | nothing below could have caused it, as far as we can see | same, **medium** confidence, limitation stated |
| `0`, and a deeper instrumented node committed | the origin is down there; this callback is only propagation | **not counted** |

That last row is why the numbers don't inflate up the tree.

`attempts > 1` for a single commit is a development replay — StrictMode's double-invoke, or a
discarded concurrent attempt. It is labelled and excluded from statistics.

## Ancestry without perturbing the tree

The nearest instrumented ancestor is propagated through a React context whose value is **created
once per mounted instance and never replaced**. A value that changed per render would force every
instrumented descendant to re-render, defeating `React.memo` and changing the behaviour of the app
being measured. A stable value costs nothing behaviourally.

The wrapper therefore adds three fibers — the wrapper component, the `Profiler`, and the provider.
That is the structural cost measured in [BENCHMARKS.md](BENCHMARKS.md).

## Timing snapshots

Props and named state changes are snapshotted **at commit time**, not read at flush time. Several
commits can queue before the deferred pass runs (any synchronous burst of updates does it), and
reading them later diffs the wrong pair. Hook-mode records and context updates carry no Profiler
commit time, so they are matched to the next commit that follows them **by sequence number**,
never by wall-clock.

## Bounded by construction

- events in a fixed-capacity ring buffer
- inspection capped on depth, object keys, array length, string length and total nodes
- one previous-props reference per component, released on unmount
- durations sampled to the last 200 per component for percentiles
- the deferred sweep clears attempts that never reached a commit
- `setTimeout` handles are `unref`'d so diagnostics never hold a Node process open

## No private React APIs

There is no `adapters/` directory because nothing needs adapting: `Profiler`, `createContext`,
`useState`, `useRef` and `useLayoutEffect` are all public and stable across React 16.9 → 19.
Everything this costs us is documented in [FEASIBILITY.md](FEASIBILITY.md); the alternative —
reading fibers — buys more data and breaks on a minor release.
