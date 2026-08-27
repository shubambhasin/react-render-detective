# Changelog

## 0.1.0

First release.

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

### Verified

- React 18 and React 19, 74 tests each.
- Packed tarball installed into a clean project: ESM, CJS and TypeScript consumers all resolve.

### Known limitations

See [docs/FEASIBILITY.md](docs/FEASIBILITY.md). Briefly: no source locations (needs a build-time
transform), no automatic context-subscription map, no effect dependency analysis — each is
impossible without private React internals, which this package does not use.
