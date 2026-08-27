import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const src = (file: string) => new URL(`../../src/${file}`, import.meta.url).pathname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    /*
     * The example consumes the package from source so `npm run dev` picks up
     * edits. Array form with anchored patterns, not the object form: object
     * aliases match by *prefix*, which would rewrite the `/overlay` subpath to
     * `src/index.ts/overlay`. A real app just installs the package and needs
     * none of this.
     */
    alias: [
      { find: /^react-render-detective\/overlay$/, replacement: src("overlay/index.ts") },
      { find: /^react-render-detective\/core$/, replacement: src("core/index.ts") },
      { find: /^react-render-detective$/, replacement: src("index.ts") },
    ],
  },
});
