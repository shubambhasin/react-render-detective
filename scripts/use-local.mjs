#!/usr/bin/env node
/**
 * Install the *local* package into a real application, without publishing.
 *
 * Why this exists: testing 0.4.0 against a real app previously meant publishing
 * it first, which is exactly backwards — the app is where the defects show up.
 * Everything found by pointing this tool at a real codebase (unusable console
 * output at list scale, CRA's inability to take a Babel plugin) was invisible
 * in the test suite and in the bundled example.
 *
 * Why a tarball rather than `npm link`: a symlink resolves `react` from *this*
 * package's node_modules, so the app ends up with two Reacts and hooks explode
 * in ways that have nothing to do with your change. A tarball is byte-identical
 * to what `npm publish` would upload, so it also exercises `files`, the exports
 * map and the built output — the things that broke in 0.1.1 and 0.1.2.
 *
 *   node scripts/use-local.mjs ../../fast-app
 *   node scripts/use-local.mjs ../../fast-app --skip-build
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const skipBuild = args.includes("--skip-build");

if (!target) {
  console.error(
    "Usage: node scripts/use-local.mjs <path-to-app> [--skip-build]\n\n" +
      "Installs this package into the app from a freshly packed tarball, so you can\n" +
      "test a change in a real application before publishing anything.",
  );
  process.exit(1);
}

const appDir = isAbsolute(target) ? target : resolve(process.cwd(), target);
if (!existsSync(join(appDir, "package.json"))) {
  console.error(`No package.json at ${appDir} — is that the app's root?`);
  process.exit(1);
}

const run = (cmd, cmdArgs, cwd) =>
  execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const appName = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).name ?? appDir;

if (!skipBuild) {
  console.log("Building…");
  run("npm", ["run", "build"], root);
  /*
   * The same guard the publish path uses. If the tarball would be rejected for
   * publishing, it should not be tested either — otherwise you validate an
   * artifact that can never ship.
   */
  console.log("Verifying the package (same checks as publish)…");
  run("node", ["scripts/verify-package.mjs", "--allow-dirty"], root);
}

const staging = mkdtempSync(join(tmpdir(), "rrd-local-"));
try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", staging], root));
  const tarball = join(staging, packed[0].filename);

  console.log(`Installing react-render-detective@${version} into ${appName}…`);
  run("npm", ["install", "--no-save", "--no-audit", "--no-fund", tarball], appDir);

  const installed = JSON.parse(
    readFileSync(join(appDir, "node_modules", "react-render-detective", "package.json"), "utf8"),
  );

  console.log(
    `\nDone. ${appName} now has react-render-detective@${installed.version} from your working tree.\n\n` +
      "  --no-save was used, so the app's package.json is untouched. `npm ci` or a\n" +
      "  fresh `npm install` in the app will replace it with the published version.\n\n" +
      "Next:\n" +
      "  1. restart the app's dev server (bundlers cache resolved modules)\n" +
      "  2. exercise the flow you care about\n" +
      "  3. re-run this script after each change to the package\n",
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
