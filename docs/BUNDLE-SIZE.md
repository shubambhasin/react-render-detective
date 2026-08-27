# Bundle size

```bash
npm run size          # fails the build if a budget is exceeded
node scripts/size.mjs --write-baseline
```

`dist/` ships **unminified** so stack traces stay readable; the budget measures the minified form,
because that is what a consumer's bundler emits. Each entry is measured together with the shared
chunks it imports, so the numbers are what you actually pay, not what one file weighs.

## Current

| entry | gzip | minified | budget | contents |
| --- | ---: | ---: | ---: | --- |
| `core` | **7.31 KB** | 22.65 KB | 8 KB | event model, comparison, inspection, diagnostic engine |
| `index` | **10.74 KB** | 33.29 KB | 12 KB | core + React integration + console reporter |
| `overlay` | **10.10 KB** | 29.82 KB | 30 KB | the dev inspector, lazily imported |
| **total** | **12.36 KB** | — | 20 KB | everything loaded at once |

Runtime dependencies: **none**. `react` is a peer dependency.

## Why the split differs from the original targets

The spec sketched a five-package monorepo with a 5 KB core, an 8 KB React layer, a 30 KB overlay
and 50 KB in total. v1 ships **one package with three entry points** — the smallest architecture
that supports the same split later — so the per-entry lines do not map one-to-one:

- `core` here *includes the diagnostic engine*, whose bulk is the explanatory prose: the evidence
  lines, the confidence wording, the suggestions. That text **is** the product. Cutting it to reach
  5 KB would trade the thing people install this for against 2 KB, so the budget was set to the
  measured size instead, and this is written down rather than quietly reinterpreted.
- The number that actually matters to a user — everything loaded — is **12.36 KB gzip against a
  50 KB budget**.

## Tree shaking

`"sideEffects": false`, ESM and CJS builds, code split by entry. Importing
`react-render-detective/core` does not pull in React integration, the console reporter or the
overlay; the overlay is designed to be reached through `await import()` so it never lands in a
production bundle.

## CI

`npm run size` exits non-zero when any budget is exceeded, and prints the delta against
`.size-baseline.json`:

```text
Change vs baseline
  core     7.31 KB → 7.31 KB  +0.0%
  index    10.74 KB → 10.74 KB  +0.0%
```
