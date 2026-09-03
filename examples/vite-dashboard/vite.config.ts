import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { renderDetective } from "../../src/vite/index.js";

// fileURLToPath, not `.pathname`: the latter percent-encodes spaces in the path.
const src = (file: string) => fileURLToPath(new URL(`../../src/${file}`, import.meta.url));

export default defineConfig({
  plugins: [
    /*
     * Automatic instrumentation. Every component in this app is tracked without
     * a single manual wrapper, and each diagnosis carries a source location.
     *
     * `importSource` points at the local source only because this example lives
     * inside the repo. A real app omits it and the package name is used.
     */
    renderDetective({ importSource: src("index.ts") }),
    react(),
  ],
  resolve: {
    // Array form with anchored patterns, not the object form: object aliases
    // match by prefix, which would rewrite the `/overlay` subpath.
    alias: [
      { find: /^react-render-detective\/overlay$/, replacement: src("overlay/index.ts") },
      { find: /^react-render-detective\/core$/, replacement: src("core/index.ts") },
      { find: /^react-render-detective$/, replacement: src("index.ts") },
    ],
  },
});
