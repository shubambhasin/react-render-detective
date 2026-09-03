/**
 * Vite plugin: instrument every component in dev, with source locations.
 *
 * A thin wrapper around the Babel plugin — the transform lives in one place so
 * Vite, webpack, Next and Remix all behave identically.
 *
 * `@babel/core` is an optional peer dependency. Vite's React plugin already
 * brings it, so most projects need no extra install; the core runtime keeps its
 * zero-dependency guarantee because none of this ships to the browser.
 */
import babelPlugin from "../babel/index.js";
import type { RenderDetectivePluginOptions } from "../babel/index.js";

export interface VitePluginOptions extends RenderDetectivePluginOptions {
  /** Files to transform. Defaults to `.jsx` / `.tsx` outside node_modules. */
  filter?: (id: string) => boolean;
}

interface MinimalVitePlugin {
  name: string;
  enforce?: "pre" | "post";
  apply?: "serve" | "build";
  transform?: (code: string, id: string) => Promise<{ code: string; map: unknown } | null>;
}

const DEFAULT_FILTER = (id: string): boolean =>
  /\.[jt]sx$/.test(id.split("?")[0] ?? id) && !id.includes("node_modules");

export function renderDetective(options: VitePluginOptions = {}): MinimalVitePlugin {
  const filter = options.filter ?? DEFAULT_FILTER;
  let transformAsync: typeof import("@babel/core").transformAsync | undefined;

  return {
    name: "react-render-detective",
    // After JSX is still present but before it is compiled away.
    enforce: "pre",
    // Dev only. There is no way to ask for this in a production build, by design.
    apply: "serve",

    async transform(code: string, id: string) {
      if (!filter(id)) return null;
      // Cheap bail-out: no JSX, nothing to instrument.
      if (!code.includes("<")) return null;

      if (!transformAsync) {
        try {
          // Babel 8 is ESM with named exports; Babel 7 is CJS and may arrive
          // under `default`. Support both rather than assuming the user's major.
          const mod = (await import("@babel/core")) as unknown as {
            transformAsync?: typeof import("@babel/core").transformAsync;
            default?: { transformAsync?: typeof import("@babel/core").transformAsync };
          };
          transformAsync = mod.transformAsync ?? mod.default?.transformAsync;
        } catch {
          /* fall through to the error below */
        }
        if (!transformAsync) {
          throw new Error(
            "[react-render-detective] @babel/core is required for automatic instrumentation.\n" +
              "Install it (`npm i -D @babel/core`) or remove the renderDetective() plugin.",
          );
        }
      }

      const result = await transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        parserOpts: { plugins: ["jsx", "typescript"] },
        plugins: [[babelPlugin, { enabled: true, ...options }]],
      });

      if (!result?.code) return null;
      return { code: result.code, map: result.map };
    },
  };
}

export default renderDetective;
export type { RenderDetectivePluginOptions };
