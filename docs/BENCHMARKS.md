# Benchmarks

```bash
npm run build
node --expose-gc bench/run.mjs
```

**Last re-measured after the 0.7.0 comparison-bound change.** The numbers below are from the current build, not from an old one —
they were first taken at 0.1.0, and since then the package gained the diagnostic engine, remount
detection, opportunity ranking, interaction attribution, colouring and store attribution. The
per-component cost did not move, because that work happens **off the render path**: the render path
still only increments a counter and stores a props reference, and everything else runs in a
microtask after the commit or behind an opt-in.

Environment: Node 24, jsdom, React 19 development build, Apple Silicon. jsdom is not a browser, so
read these as **relative** numbers — identical workloads with and without instrumentation,
interleaved in one process, median of 7 samples of 20 full-tree updates.

The benchmarked component is a small leaf that does a little real work (string formatting, three
elements) and receives a recreated `style` object every render — i.e. the case that costs the tool
the most, since every render produces a prop diff.

## Overhead when **every** component is instrumented

| components | baseline | structural (wrapped, disabled) | default | deep inspection |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 1.24 ms | 1.83 ms (+48.0%) | 2.02 ms (+63.3%) | 2.17 ms (+75.2%) |
| 1 000 | 18.29 ms | 21.10 ms (+15.4%) | 28.62 ms (+56.5%) | 25.46 ms (+39.2%) |
| 5 000 | 83.72 ms | 115.63 ms (+38.1%) | 139.38 ms (+66.5%) | 140.07 ms (+67.3%) |

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
| 100 | 5.94 µs | 1.89 µs | 7.83 µs |
| 1 000 | 2.81 µs | 7.52 µs | 10.33 µs |
| 5 000 | 6.38 µs | 4.75 µs | 11.13 µs |

**≈ 0.008–0.011 ms per instrumented component**, against the 0.1 ms target — met with roughly 9×
headroom, and unchanged from 0.1.0 despite six releases of features. The split between structural
and recording moves around between runs; the total is the stable figure.

## Overhead at realistic instrumentation levels

Same 2 000-component tree; only the share of wrapped components changes.

| instrumented | baseline | instrumented | overhead |
| ---: | ---: | ---: | ---: |
| 40 (2%) | 34.07 ms | 32.95 ms | **−3.3%** |
| 200 (10%) | 34.25 ms | 36.26 ms | **+5.9%** |
| 1 000 (50%) | 34.36 ms | 45.15 ms | +31.4% |

The 2% row came out *negative* — the instrumented arm measured faster than the baseline, which is
impossible. It is measurement noise, and the honest reading is that at 2% instrumentation the
overhead is **below what this harness can resolve**, not that the tool makes an app faster. Treat
anything under about 5% here as noise.

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
