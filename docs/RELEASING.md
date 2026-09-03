# Releasing

**Releases are published by CI from a clean checkout. Do not run `npm publish` locally.**

## Why

Both of this package's first two releases went out from a local working tree, and both were wrong:

- **0.1.0** was published from a tree that predated four defects found later by running the demo in
  a real browser.
- **0.1.1** was published from a tree whose `package.json` npm had rewritten to declare ~200
  transitive dev packages as runtime dependencies. It fails to install on Linux, because the
  darwin-only `fsevents` is among them.

The second one happened **twice** — again while verifying 0.1.2, from a different npm command. The
trigger is npm reifying a `node_modules` tree left out of sync by an earlier `--no-save` install,
and it rewrites the manifest silently. A local tree is therefore not a trustworthy publish source,
and no amount of care makes it one.

A clean CI checkout cannot have either problem: there is no stale `node_modules` to reify, and
nothing uncommitted to publish.

## One-time setup

1. Create an npm **automation** token (npmjs.com → Access Tokens → Generate → Automation). It
   bypasses 2FA, which is what lets CI publish.
2. Add it to the repository:

   ```bash
   gh secret set NPM_TOKEN --repo shubambhasin/react-render-detective
   ```

## Cutting a release

```bash
# 1. Bump. Nothing else edits the version.
npm version patch          # or minor / major

# 2. Sync the version strings npm does not know about, and write the changelog.
#    README status line · site/index.html status line · a new CHANGELOG section.

# 3. Sanity-check before committing (every tarball check runs; only the
#    "manifest matches HEAD" check is relaxed, and it still fails on keys npm
#    added behind your back).
npm run verify -- --allow-dirty

# 4. Commit, then verify strictly — this is what CI will do.
git add -A && git commit -m "Release vX.Y.Z"
npm run verify

# 5. Tag and push. The tag is what triggers the release.
git tag -a vX.Y.Z -m "X.Y.Z"
git push --follow-tags origin main
```

The `Release` workflow then, on the tag:

1. checks out the tag into a clean tree and runs `npm ci`
2. refuses to continue unless the tag matches `package.json`
3. runs typecheck, tests, build and the bundle-size budgets
4. runs `scripts/verify-package.mjs` against the packed tarball
5. refuses to continue if `package.json` or the lockfile changed during any of that
6. publishes with `--provenance`
7. **re-reads the published metadata from the registry** and fails the release if it declares any
   runtime dependencies, printing the `npm deprecate` command to run
8. creates the GitHub release from the changelog section

Step 7 is the backstop: it checks what actually landed, not what was meant to land.

## The guard

`npm run verify` (also wired to `prepublishOnly`, so a local publish is blocked too) checks the
**packed tarball**, not the source tree:

| check | the failure it exists for |
| --- | --- |
| `package.json` matches `HEAD` | npm rewriting the manifest under you — this is what shipped 0.1.1 **and** 0.1.2 |
| zero runtime dependencies | the same defect, seen from the tarball side |
| `peerDependencies` is exactly `react` | an accidental peer breaks every install |
| tarball version matches the manifest | publishing a stale build |
| `publishConfig.access`, `sideEffects` | private-by-accident; silently breaking tree shaking |
| required files present | shipping without `dist`, a README or the licence |
| forbidden paths absent | leaking `src/`, `tests/`, `.env`, nested tarballs |
| built CJS bundle exports the public API | a build that cannot be loaded |

## If a bad version does get out

```bash
npm deprecate react-render-detective@<version> "<what is wrong>. Use <good version>."
```

Deprecation is reversible — pass an empty string to undo. Prefer it to unpublishing: unpublishing
burns the version number permanently and breaks anyone who already installed it.
