# Benchmarks

```bash
npm run build
node --expose-gc bench/run.mjs
```

Environment: Node 24, jsdom, React 19 development build, Apple Silicon. jsdom is not a browser, so
read these as **relative** numbers — identical workloads with and without instrumentation,
interleaved in one process, median of 7 samples of 20 full-tree updates.

The benchmarked component is a small leaf that does a little real work (string formatting, three
elements) and receives a recreated `style` object every render — i.e. the case that costs the tool
the most, since every render produces a prop diff.

## Overhead when **every** component is instrumented

| components | baseline | structural (wrapped, disabled) | default | deep inspection |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 1.31 ms | 1.82 ms (+38.6%) | 2.23 ms (+69.7%) | 2.19 ms (+66.7%) |
| 1 000 | 18.36 ms | 21.49 ms (+17.1%) | 28.93 ms (+57.6%) | 25.97 ms (+41.5%) |
| 5 000 | 84.80 ms | 119.73 ms (+41.2%) | 146.12 ms (+72.3%) | 145.34 ms (+71.4%) |

Two costs are separated deliberately:

- **structural** — the three extra fibers per wrapped component (wrapper, `Profiler`, ancestry
  provider) with recording switched off. This is React's cost, not ours, and it is why the
  `disabled` arm is not free.
- **recording** — everything the detective actually does: counting, snapshotting props, queueing
  the commit, and the deferred diffing and diagnosis.

Deep inspection lands inside the noise of default here, because at depth 1 the diff already walks
the `style` object; depth mainly costs on large nested props.

## Per-instrumented-component cost

| components | structural | recording | total |
| ---: | ---: | ---: | ---: |
| 100 | 5.05 µs | 4.09 µs | 9.14 µs |
| 1 000 | 3.13 µs | 7.44 µs | 10.57 µs |
| 5 000 | 6.99 µs | 5.28 µs | 12.26 µs |

**≈ 0.009–0.012 ms per instrumented component**, against the 0.1 ms target in the spec — met with
roughly 8× headroom.

## Overhead at realistic instrumentation levels

Same 2 000-component tree; only the share of wrapped components changes.

| instrumented | baseline | instrumented | overhead |
| ---: | ---: | ---: | ---: |
| 40 (2%) | 35.02 ms | 36.89 ms | **+5.3%** |
| 200 (10%) | 36.22 ms | 38.34 ms | **+5.9%** |
| 1 000 (50%) | 35.55 ms | 49.42 ms | +39.0% |

### Honest reading of these numbers

The `<5%` target in the spec is **not** met when you wrap every trivial leaf in a large tree, and
it would be dishonest to present a headline figure that hides that. What the data actually says:

- Cost is **per instrumented component**, roughly 10 µs, and essentially flat with tree size.
- Percentage overhead is therefore a function of two things you control: how many components you
  wrap, and how much work each one does. A component that renders in 10 µs pays 100%; a component
  that renders in 1 ms pays 1%.
- At the intended usage — instrumenting the part of the app you are investigating — overhead sits
  at **≈5%**, and it is the trivial-leaf case (10 µs of real work per component) that drags it
  there. Wrap components that do real work and it disappears into the noise.
- If you need it lower: `samplingRate`, `include`/`exclude`, or wrapping a subtree root instead of
  every leaf.

## Memory

200 000 render events recorded directly (no React, so the number is the tool's own retention):

| `maxEvents` | heap growth | events retained | renders counted |
| ---: | ---: | ---: | ---: |
| 1 000 | **+1.6 MB** | 1 000 | 200 000 |
| 50 000 | +121.9 MB | 50 000 | 200 000 |

Growth is bounded by `maxEvents` and nothing else — statistics for all 200 000 renders are kept in
fixed-size accumulators. Budget roughly **2.4 KB per retained event** if you raise the cap.

## What is not measured here

- Real-browser numbers. jsdom's DOM is cheaper than a real one, which *inflates* the relative
  overhead — the instrumented and baseline arms share the same DOM cost, so a heavier real DOM
  moves the percentage down, not up.
- Production builds. `Profiler` timings require a development or profiling build, and the package
  is dev-only by design.
