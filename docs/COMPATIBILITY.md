# React compatibility

| React | Status | Notes |
| --- | --- | --- |
| 19.x | **Tested** | Test suite and benchmarks run here. `ref` is an ordinary prop, so it passes through `withRenderDetective`'s spread. |
| 18.x | Supported by API surface, not yet exercised in CI | Everything used is 16.9+ public API. `ref` is *not* a prop before 19 — wrap with `forwardRef` yourself if a wrapped component needs one. |
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
  and the extra invocation is reported as a development replay. Statistics are never doubled.
- **Concurrent rendering**: `onRender` fires only for committed work. Attempts with no commit are
  swept and counted separately as uncommitted; they never enter the performance numbers.
- **Fast Refresh**: the detective is pinned to a `globalThis` symbol, so a reloaded module reuses
  the same instance. `init()` is idempotent.
- **Bundler renaming**: minifiers and even esbuild's duplicate-identifier handling can rename
  `function Solo` to `Solo2`. Pass `{ name }` when the inferred name matters.
