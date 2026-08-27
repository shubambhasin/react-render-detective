# React compatibility

| React | Status | Notes |
| --- | --- | --- |
| 19.x | **Tested** | Test suite and benchmarks run here. `ref` is an ordinary prop, so it passes through `withRenderDetective`'s spread. |
| 18.x | **Tested** (74 tests, one behavioural difference below) | `ref` is *not* a prop before 19 — wrap with `forwardRef` yourself if a wrapped component needs one. |
| 17.x, 16.9+ | Supported by API surface | `Profiler`, `createContext`, `useState`, `useRef`, `useLayoutEffect`. |
| < 16.9 | Not supported | `Profiler` is unavailable. |

## APIs used

All public, all stable:

- `<Profiler onRender>` — commit identity and durations
- `createContext` / `useContext` — ancestry, with a value that never changes
- `useState` (lazy initializer) — per-instance node
- `useLayoutEffect` — attach/detach in the registry
- `useCallback`, `useRef`, `useEffect`

**No private React internals are used.** There is deliberately no `adapters/react-18.ts` — nothing
needs adapting. If internals are ever adopted (for fiber-accurate parents or hook state), they go
behind a capability check in `src/react/adapters/`, never inline.

## Behaviour worth knowing

- **StrictMode** double-invokes render functions in development. Renders are counted per *commit*,
  so statistics are never doubled on any version.

  Whether the extra invocation can be *labelled* differs: React 19 re-runs the render function
  against the same hook state, so both passes reach the same instrumented node and the replay is
  named in the evidence. React 18 discards the first pass's hook state, so the extra attempt is
  never observed — counts remain correct, but you will not see the "development replay" line.
  `useTrackedState`'s ownership guard uses `useId`, which is React 18+; on React 17 and below the
  guard is skipped (see the note on `useTrackedState` in the API reference).
- **Concurrent rendering**: `onRender` fires only for committed work. Attempts with no commit are
  swept and counted separately as uncommitted; they never enter the performance numbers.
- **Fast Refresh**: the detective is pinned to a `globalThis` symbol, so a reloaded module reuses
  the same instance. `init()` is idempotent.
- **Bundler renaming**: minifiers and even esbuild's duplicate-identifier handling can rename
  `function Solo` to `Solo2`. Pass `{ name }` when the inferred name matters.
