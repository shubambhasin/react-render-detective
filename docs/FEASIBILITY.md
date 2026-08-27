# Phase 1 — Technical Feasibility Report

What React can actually tell us at runtime, using **public APIs only**, and what it cannot.
Everything the product promises is classified here before any of it is built.

Legend:

| Tier | Meaning |
| --- | --- |
| ✅ Reliable | Public, documented React API. Stable across React 18/19. |
| 🟡 Possible | Derivable by correlation/inference. Correct, but confidence must be reported as < high. |
| 🧪 Experimental | Works, but depends on heuristics that can misfire. Must be opt-in and labelled. |
| ⛔ Not without private APIs | Requires fiber internals (`__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`). Excluded from v1. |

---

## 1. What renders, and how many times

**✅ Reliable.** A counter incremented in the render body of a wrapper component counts
**render attempts** exactly. This is not the same as commits (see §5).

`<Profiler onRender>` fires once per **committed** render for every Profiler whose subtree
contained work. So:

- render-body counter → attempts
- `onRender` → commits

Both are needed. Tools that report only one of the two are wrong about StrictMode and about
concurrent rendering.

## 2. Render duration

**✅ Reliable, with a caveat almost every tool gets wrong.**

`onRender(id, phase, actualDuration, baseDuration, startTime, commitTime)`:

- `actualDuration` — time to render **this Profiler's whole subtree** this commit. It is *not*
  the component's own cost.
- `baseDuration` — estimated cost to render the entire subtree without memoization.
- `commitTime` — shared by every Profiler in the same commit. This is our commit identity.

Self-time is **not** exposed. We derive it:

```
selfDuration ≈ actualDuration − Σ actualDuration of instrumented descendants in the same commit
```

That is exact when children are instrumented and an approximation otherwise, so events carry
`subtreeDuration`, `selfDuration`, and `selfDurationIsExact`. We never present subtree time as
component time.

Profiler timings require a dev or profiling build. In a plain production build `actualDuration`
is `0`, which is one more reason the package is dev-only.

## 3. Prop changes

**✅ Reliable.** Props are handed to us. We keep the previous props object in a ref and diff:

- `Object.is` for identity (handles `NaN`, `+0/-0` correctly — `===` does not)
- for two plain objects/arrays: bounded shallow compare → distinguishes *value changed* from
  *reference changed, contents equal*, which is the single most valuable diagnosis in the product
- functions: identity only. Comparing `Function.prototype.toString()` is offered as opt-in; two
  inline closures with identical source are still different closures, so equal source is evidence
  of "recreated inline callback", not of equivalence.

Deep equality is never run by default (§8 of the engineering principles).

## 4. Parent / ancestry

**✅ Reliable — with one design constraint that matters.**

Ancestry is propagated with a React context whose value is **created once per wrapper instance
and never changes**. This is critical: a context value that changed per render would force every
instrumented descendant to re-render, defeating `React.memo` and *changing the behaviour of the
app being measured*. A stable value costs nothing behaviourally.

"Did my parent render in this commit?" is then answered from data, not from the context: the
parent's own attempt counter advanced within the same `commitTime`. Diagnosis is deferred until
after the commit (§7) so the whole commit batch is available.

Limitation, stated in output: parent means **nearest instrumented ancestor**, not necessarily the
direct parent element.

⛔ Walking `fiber.return` to get the true parent chain requires internals. Excluded.

## 5. StrictMode

**🟡 Possible, and mandatory to handle.** There is no public "am I in StrictMode" flag.

But StrictMode's double-invoke is observable: the render body runs **twice** for **one** commit.
So `attempts − 1` extra attempts against a single `commitTime` ⇒ a development replay. We label
it exactly that way — *"development replay (StrictMode double-invoke or a discarded concurrent
attempt); not production behaviour"* — and we count **commits**, never attempts, in all
statistics. This is why the tool never claims "you render 2× too often" in a StrictMode app.

We cannot distinguish a StrictMode replay from a discarded concurrent attempt. We do not pretend
to; both are reported as *uncommitted attempts*.

## 6. Context-driven renders

**🟡 Possible for tracked contexts only. ⛔ Impossible in general.**

There is no public way to ask "which contexts does this component consume?" — that lives on the
fiber's dependency list. So the honest design is opt-in: the *provider* is instrumented
(`trackContextValue` / `withProviderDiagnostics`), which gives us "context X's value changed in
commit T, and here is which keys changed".

A consumer that rendered in commit T whose props did not change and whose parent did not render,
while a tracked context changed in T, is diagnosed `context` at **medium** confidence — it is a
correlation, not a subscription record. That limitation is printed with the diagnosis.

Unstable-provider-value detection is ✅ reliable, because it is just prop diffing on the value.

## 7. Concurrent rendering / commit vs abandoned

**🟡 Possible.** `onRender` only ever fires for committed work. Attempts without a matching
commit are uncommitted — abandoned, interrupted, or replayed. We flush pending attempts on a
deferred pass and mark them `committed: false`, and they never enter the performance statistics.

Deferring diagnosis also satisfies the performance requirement: the render path only pushes a
small raw record; all comparison, serialization and diagnosis happens in a microtask after commit.

## 8. State changes

**🟡 Partially. ⛔ Not by inspection.** A component's `useState` cells are fiber memoized state;
reading them needs internals.

What is reliable is **elimination**: props identical, nearest instrumented ancestor did not
render, no tracked context changed ⇒ the render originated *inside* the component or from an
external store subscription. We report that as `state-or-external` and say plainly that we cannot
tell which. Developers who want the actual values opt in with `useTrackedState`, which is a thin
`useState` wrapper and therefore ✅ reliable for what it wraps.

## 9. Hooks, effects, dependency analysis

⛔ Enumerating hooks or their deps requires internals. §19 of the spec (effect dependency
diagnostics) is **not** implemented in v1 rather than implemented inaccurately. A `useTrackedEffect`
wrapper — which reports which of *its own declared* deps changed — is reliable and is the honest
subset; it is included as an opt-in helper, not as automatic analysis.

## 10. Source locations

⛔ Not available at runtime. `_debugSource` existed on fibers in React 18 dev and was **removed in
React 19**. Real source locations need a Babel/SWC transform, which is a separate build-time
package, deliberately out of v1 scope.

What is reliable: `fn.displayName ?? fn.name`, an explicit `name` option, and the React
`Profiler` id. Anonymous components are reported as `Anonymous` with a hint to pass `name`.

## 11. React version compatibility

Everything above is React 16.9+ public API (`Profiler` `onRender`, context, refs). No adapter
layer is needed for v1 because no private API is used — which is the point. If internals are ever
adopted they go in `src/react/adapters/` behind a capability check, never inline.

---

## Summary — what v1 ships

| Feature | Tier | Confidence ceiling |
| --- | --- | --- |
| Render count (attempts + commits) | ✅ | high |
| Render duration (subtree) | ✅ | high |
| Self duration | ✅/🟡 | high when children instrumented |
| Prop identity vs value change | ✅ | high |
| Unstable object/array/function props | ✅ | high |
| Parent-propagated render | ✅ | high |
| Mount | ✅ | high |
| Uncommitted attempt / dev replay | 🟡 | medium |
| Context-driven render | 🟡 (opt-in provider) | medium |
| Unstable provider value | ✅ | high |
| State / external store render | 🟡 by elimination | medium |
| Source location | ⛔ deferred to a build plugin | — |
| Automatic context subscription map | ⛔ | — |
| Automatic effect dep analysis | ⛔ | — |

When none of the above explains a render, the tool reports
`Cause could not be determined reliably.` — never an invented cause.
