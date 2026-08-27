# Demo dashboard

A small SaaS-style admin — navbar, sidebar, filters, chart, paginated table, modal, context
provider, memoized and unmemoized components — with five render problems planted in it.

```bash
npm install
npm run dev
```

Then open the console (and the overlay in the bottom-right) and interact with the page.

## The planted problems

| # | Where | Problem | What the detective says |
| --- | --- | --- | --- |
| 1 | `SessionProvider` | provider value rebuilt every render | *unstable context value*, reference-only change |
| 2 | `Chart` | expensive, never memoized | slow/very-slow render, high cumulative cost |
| 3 | `TableRow` | `memo` defeated by an unstable `onSelect` | reference-only prop change on a memoized child |
| 4 | `Dashboard` | `rows` recomputed and reallocated on unrelated state changes | reference-only change with identical contents |
| 5 | `Dashboard` | inline `handleSelect` / `onOpenModal` closures | new function reference each render |

Toggle **Show fixed version** to run the same UI with `useMemo` / `useCallback` applied, then
compare:

```js
rrd.clear();
// interact for a while
rrd.printStats();
rrd.explain("ProductTable");
rrd.explain("TableRow");
```

The point of the toggle is that the improvement is *measured*, not assumed. Opening and closing the
modal, verified in Chrome:

| | TableRow renders | potentially avoidable |
| --- | ---: | ---: |
| broken | 40 | 40 |
| fixed | **0** | 0 |

`memo` on `TableRow` only starts working once `onSelect` stops being recreated — which is exactly
what the tool points at.

## Note on this example's imports

`vite.config.ts` aliases `react-render-detective` to the package source so edits show up
immediately. A real app just installs the package.
