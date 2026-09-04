# Changelog

## 0.6.0

### Added — external-store attribution

The gap that mattered most. A Redux or Zustand render could only ever be reported as *"state or an
external store"*: the tool proved the render started inside the component but could not say which
value caused it. On a real 167k-line application that covered **84% of one component's renders**,
which is where the product stopped being useful — and most React apps are store-driven apps.

`useSelector` is a public hook from a public package, so this needs no React internals. The Babel
plugin rewrites the call site, so nothing in your code changes:

- selectors are named from the selector itself where possible — `state => state.flights.results`
  becomes `flights.results`, which reads better than a file and line — and fall back to the call
  site otherwise
- the diagnosis reports `store` at **high** confidence, naming the selector and its location
- **the case worth having**: a selector that builds a new array or object on every call. Because
  `useSelector` compares with `Object.is`, the component then re-renders on *every* store update
  regardless of what changed. Invisible in a profiler, obvious here — reported as avoidable, with
  `createSelector` / `shallowEqual` / derive-outside as the suggested fixes.
- every argument passes through to the real hook untouched, react-redux's equality function
  included, because changing those would change your app's behaviour
- `storeHooks` points it at any other store; `trackStores: false` turns it off
- `createTrackedSelectorHook` covers custom hooks and bundlers the plugin cannot reach

Attribution follows the same ownership rule as `useTrackedState`: a selector called in an
uninstrumented descendant is not blamed on its instrumented ancestor.

### Fixed — `explain()` no longer calls a store render undetermined

`explain()` and `printOpportunities()` had no branch for the new `store` reason, so a component
whose renders were entirely store-driven was reported as *"Cause could not be determined
reliably"* — the exact opposite of the truth, since `store` is the highest-confidence diagnosis the
engine produces. Found by checking rather than assuming, immediately after building the feature it
broke.

Selector churn now ranks **above** prop churn in the headline, because a selector rebuilding its
value re-renders the component on every store update and is usually the larger cause.

### Changed — BREAKING: interaction tracking moved to its own entry point

```diff
- rrd.printInteractions();
+ import { startInteractionTracking, printInteractions } from "react-render-detective/interactions";
+ startInteractionTracking();
```

`init()` no longer starts it. Store attribution pushed the root entry to 17.02 KB — 20 bytes over a
budget that had already been raised three releases running — and 0.5.0 committed to splitting rather
than raising a fourth time. The root entry is now **15.21 KB**, and consumers who do not use INP
attribution no longer pay for it.

`clear()` and `reset()` still work correctly across the split: the interactions module registers
lifecycle hooks with the detective rather than the root entry knowing it exists.

## 0.5.0

Everything here came out of pointing the tool at a real 167k-line application for the first time.
Nothing in the test suite or the bundled example could have surfaced any of it.

### Changed — console output reports commits, not renders

A twenty-row list mounting produced roughly 200 lines of `FareTile #1 mount 0.1ms`, which Chrome
then collapsed into `2×` markers. It buried the two lines that mattered, and printing it slowed the
app being measured.

- one aggregated line per batch, coalesced over 400ms
- **a batch with nothing actionable prints nothing at all** — cheap, fully explained renders are
  normal behaviour, and reporting them teaches people to ignore the console
- per component: count, total cost, and the reason behind the *actionable* renders rather than the
  most frequent one, so twelve mounts plus twelve avoidable updates is not labelled `mount`
- `verbose` keeps the per-render detail for when `include` has narrowed the scope

Measured on the same app afterwards: an entire search-and-sort session printed **two** lines.

If you relied on a line per render, that is now `mode: "verbose"`.

### Added — colour

Red for a component that was rebuilt, amber for slow or avoidable, green for renders that were
justified, grey for context. Colour never carries meaning on its own: every line keeps its glyph
and its words, so the output survives being pasted into an issue or read with a different palette.
The `%c` directive count and style-argument count are matched by construction, since a mismatch is
the usual way this browser API breaks.

### Fixed — hot reload is no longer diagnosed as a `key` problem

Editing the package hot-reloaded the demo, React Fast Refresh rebuilt the tree, twenty rows
remounted, and the tool announced *"rebuilt — check the `key` given to TableRow"*. The remount was
real; the diagnosis was nonsense. This tool only ever runs in development, so hot reload is the
single most common cause of remounts it will ever see — it would have said that to every user
several times an hour.

Remounts of three or more distinct components inside 1.5s are now reported as a whole-tree rebuild
at low confidence, with nothing to fix. A real key problem affects one component; a reload affects
many at once. The inline-definition signal still wins, because a component declared in a render
body is a bug either way.

### Added — the changelog is published and enforced

Shipped in the tarball, rendered to
[a page](https://shubambhasin.github.io/react-render-detective/changelog.html) at deploy time so it
cannot drift, and required by `prepublishOnly` and the release workflow — a release with no entry
is now impossible rather than merely discouraged. `npm version` inserts the heading and syncs the
version strings that npm does not know about.

### Added — a way to test locally before publishing

`npm run use-local -- ../path/to/app` installs the working tree into a real application from a
packed tarball, behind the same guard the publish path uses. Testing 0.4.0 in an app previously
meant publishing it first, which is backwards. A tarball rather than `npm link`, so the app keeps
one React and the exports map gets exercised too.

### Note on bundle size

`index` moved 16 → 17 KB and that is the last raise. The next release that would exceed it splits
interaction tracking behind `react-render-detective/interactions` instead — a breaking change, and
therefore a scheduled one. See [docs/BUNDLE-SIZE.md](docs/BUNDLE-SIZE.md).

## 0.4.0

### Added — triage, interactions, and a regression gate

**`printOpportunities()` — where to spend your next hour.** Components ranked by estimated
recoverable time rather than render count, because a component rendering 2 000 times for 0.01ms is
not the problem and one rendering 40 times for 12ms might be. Remounts are charged at the cost of a
mount. Built on the diagnostic engine, so a ranking and a diagnosis can never disagree.

**Interaction and INP attribution.** The browser reports how long an interaction took; the render
events say which components spent it. Captured automatically through the Event Timing API for
anything over one frame, with `measureInteraction(label, fn)` for the two cases the automatic path
cannot see — Safari before 16.4, and synthetic input, which never produces those entries.

A manual measurement waits for the next frame, and a hidden or throttled tab can stretch that to
hundreds of milliseconds of idling. Measuring in a real browser showed exactly that — a 12ms click
reported as 922ms — so the summary now separates handler time from render time and says plainly
when the window was mostly the page waiting, rather than presenting idle time as your problem.

**`react-render-detective/testing` — a render regression gate.** Snapshot renders, remounts and
avoidable renders for a scripted interaction, commit the baseline, and fail the pull request when
it regresses. Assertion-library agnostic: `compareProfiles` returns data, `assertNoRenderRegressions`
throws. Improvements never fail the build but are reported with a nudge to re-baseline.

### Fixed

- `measureInteraction` relied on `requestAnimationFrame`, which does not fire in a hidden tab and
  does not exist in jsdom — an interaction would simply never have been recorded. A timer now races
  it, whichever fires first.

## 0.3.0

### Added — remount detection

A remount is not a render: React throws the instance away, along with its DOM and all of its state,
and builds a new one. It costs more than any re-render, and the two most common causes are silent.

- Components rebuilt rather than re-rendered are now counted (`remountCount`) and reported, with the
  cause named: a component **declared inside another component's render body**, or a **changing
  `key`**.
- The inline-definition case is answered *statically by the build plugin*, which passes
  `declaredInRender`. A first attempt inferred it at runtime by timing repeated definitions, and it
  broke as soon as a user clicked more than five seconds apart — the compiler already knows the
  answer, so it tells the runtime instead of the runtime guessing.
- StrictMode's simulated unmount/remount is excluded: it reuses the same fiber, whereas a real
  remount always produces a new instance. Without that, every component in a StrictMode app would be
  flagged.
- Ordinary mounting is not flagged. A growing list mounts components; nothing is reported until a
  component has actually been rebuilt repeatedly.
- Surfaced in `explain()` (it outranks every render explanation), `printStats()` and the overlay.

### Fixed

- The build plugin skipped the entire body of any component it instrumented, so components declared
  **inside** another component — the exact case remount detection exists for — were never seen.
  `path.skip()` replaced with a processed-node guard.
- The Vite plugin assumed Babel 8's ESM shape and would have failed for anyone on Babel 7.

## 0.2.0

### Added — automatic instrumentation

A build-time transform that instruments every component in development, shipped as a Babel plugin
(`react-render-detective/babel`) and a Vite plugin (`react-render-detective/vite`) that share one
implementation.

Wrapping components by hand only ever finds problems you already suspected. This turns the tool
from a probe into a scanner, and it is also the only way to get **source locations** — React
removed `_debugSource` in 19, so there is no runtime alternative. Diagnoses now read
`TableRow   src/App.tsx:85:7`, and fix instructions name the file and line of the component that
passes the unstable prop.

- Instruments uppercase-named functions returning JSX, including arrow components and the function
  inside `memo()` / `forwardRef()` — *inside*, so `memo` still compares props first.
- Function declarations are instrumented by reassignment rather than rewritten to `const`, since
  components are routinely used above their definition and a `const` would produce a temporal dead
  zone error.
- Leaves alone: hooks, lowercase functions, functions that never return JSX, JSX from a nested
  closure, hand-wrapped components, `node_modules`, and the detective's own runtime.
- `clientOnly` skips files without a `"use client"` directive, for the Next.js app router.
- `@babel/core` is an **optional** peer dependency and never reaches the browser; the runtime keeps
  its zero-dependency guarantee, and the size gate now fails if build-time code leaks into a
  runtime entry.

### Fixed

- `withRenderDetective` returns an already-wrapped component unchanged instead of nesting. Found by
  running the plugin against this repo's own example: it instrumented the detective's runtime, the
  wrapper rendered itself, and the app died with a stack overflow before first paint. The plugin
  now refuses to touch its own runtime, and the HOC refuses to wrap a wrapper.

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
