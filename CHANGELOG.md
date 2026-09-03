# Changelog

## 0.1.3

**Use this version.** It is the first release published by CI from a clean checkout, and the first
whose metadata is correct.

`0.1.0`, `0.1.1` and `0.1.2` were all published from a local working tree, and none of them should
be used:

| version | problem |
| --- | --- |
| `0.1.0` | predates four render-attribution defects found by running the demo in a real browser |
| `0.1.1` | `package.json` declares ~200 transitive dev packages as runtime dependencies; fails to install on Linux |
| `0.1.2` | same defect, 122 dependencies — published from the polluted tree before the guard existed |

The cause was npm silently rewriting `package.json` while reifying a `node_modules` tree left out
of sync by an earlier `--no-save` install. It happened three times, from three different npm
commands, which is why releases no longer come from a local tree at all. See
[docs/RELEASING.md](docs/RELEASING.md).

Code is unchanged from `0.1.2`; only the release path and metadata differ.

## 0.1.2

Withdrawn — 122 spurious runtime dependencies. `0.1.1` shipped a broken `package.json`: a stray
`npm install --package-lock-only` had written a `dependencies` block into it listing ~200
transitive dev packages as runtime dependencies of this package. Installing `0.1.1` therefore
pulls in the whole dev toolchain, and fails outright on Linux because the darwin-only `fsevents`
is among them. `0.1.2` is byte-identical in behaviour and declares what it actually needs: no
dependencies, and `react` as its only peer.

`0.1.0` was published before the four defects below were found, and should also be avoided.

Releases now come from CI on a tag, never from a local tree, and a publish guard
(`scripts/verify-package.mjs`, wired to `prepublishOnly`) checks the packed tarball and refuses to
publish a manifest that differs from the committed one. See [docs/RELEASING.md](docs/RELEASING.md).

## 0.1.1

Withdrawn — see above. Contents are otherwise the same as `0.1.2`.

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
