# Changelog

## 0.1.1

First published release. `0.1.0` existed only during development and was never published, so
everything below is what ships in `0.1.1`.

### Added

- Render tracking via `withRenderDetective`, `<RenderDetective>` and `useRenderDiagnostics`.
- Prop comparison that separates a real value change from a **reference-only** change, using
  `Object.is` semantics and a bounded shallow compare.
- Parent attribution: each commit is attributed to props, parent propagation, tracked context,
  named state, or an origin at/below the component — never counted twice up the ancestor chain.
- Profiler-based timings with self duration derived by subtracting instrumented descendants, and
  labelled as the upper bound it is.
- Confidence (`high` / `medium` / `low`) and printed limitations on every diagnosis.
- StrictMode awareness: renders counted per commit, extra invocations reported as development
  replays and excluded from statistics.
- `explain()` / `explainStructured()` — aggregated causality for one component.
- Console reporter (concise and verbose) and a plain-DOM overlay rendered outside the React tree.
- `useTrackedState`, `useTrackedContextValue`, `useTrackedEffect` for what the runtime cannot see.
- Filtering (`include` / `exclude`), per-instance sampling, bounded ring buffer, bounded inspection.
- Zero runtime dependencies, ESM + CJS + types, `sideEffects: false`, three entry points.
- Bundle-size budgets in CI and an instrumentation-overhead benchmark suite.

### Fixed before release

Found by running the demo dashboard in a real browser, which the jsdom test suite had not covered:

- `init()` recorded nothing under a Vite dev server. Dev detection asked "is this development?" and
  answered *no* whenever `process` was absent — which is the case in a browser — so the documented
  quick-start turned the tool on and then stayed silent. It now asks the opposite question and only
  disables itself when it can positively see a production build, and says so if it does.
- StrictMode's effect double-invoke wiped the recorded props on mount, so the first update of every
  component reported **every** prop as newly added. Registry detach no longer clears props.
- `explain()` called reference-only prop changes "genuinely new values", and diluted every share by
  counting mounts in the denominator — a prop responsible for 100% of a list row's updates read as
  33%. Shares are now measured over updates, and the wording checks what is actually in the bucket.
- `explain()` said an unstable prop was "created in" the nearest instrumented ancestor. That is
  where it *arrives from*; it now says so.
- The example's Vite alias matched by prefix, rewriting `react-render-detective/overlay` to
  `src/index.ts/overlay` and breaking the demo on first run.

### Verified

- React 18 and React 19, 74 tests each.
- Packed tarball installed into a clean project: ESM, CJS and TypeScript consumers all resolve.

### Known limitations

See [docs/FEASIBILITY.md](docs/FEASIBILITY.md). Briefly: no source locations (needs a build-time
transform), no automatic context-subscription map, no effect dependency analysis — each is
impossible without private React internals, which this package does not use.
