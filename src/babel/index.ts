/**
 * Babel plugin: instrument every React component in a file at build time.
 *
 * Why this exists: without it you only learn about components you already
 * suspected, because you have to wrap them by hand. With it, the tool reports
 * on the whole tree — and it can attach a real source location, which React
 * itself no longer exposes at runtime (`_debugSource` was removed in React 19).
 *
 * Build-time only. It must never run in a production build, and it removes
 * itself when `NODE_ENV` is production unless explicitly forced.
 */
import type { NodePath, PluginObject, PluginPass, types as BabelTypes } from "@babel/core";

export interface RenderDetectivePluginOptions {
  /** Defaults to `NODE_ENV !== "production"`. */
  enabled?: boolean;
  /** Only instrument files whose path matches. Empty = all files. */
  include?: Array<string | RegExp>;
  /** Skip files whose path matches. Applied after `include`. */
  exclude?: Array<string | RegExp>;
  /**
   * Skip files with no `"use client"` directive. Turn this on for the Next.js
   * app router: server components never render on the client, and wrapping one
   * in a hook-using HOC would break the build.
   */
  clientOnly?: boolean;
  /** Import specifier for the runtime. Overridable for testing and monorepos. */
  importSource?: string;
  /** Root used to make source locations relative. Defaults to `process.cwd()`. */
  root?: string;
}

interface State extends PluginPass {
  opts: RenderDetectivePluginOptions;
  rrdLocal?: BabelTypes.Identifier;
  rrdTouched?: boolean;
  rrdRelativePath?: string;
}

const DEFAULT_IMPORT_SOURCE = "react-render-detective";

/*
 * Never instrument the detective's own runtime. Its HOC returns a component
 * that renders the component it was given; instrumenting that makes it render
 * itself, and the app dies with a stack overflow before the first paint.
 *
 * node_modules covers the normal install. This covers a source alias — how the
 * bundled example consumes the package, and how anyone working on it locally
 * would too.
 */
const SELF_PATTERN = /[/\\]react-render-detective[/\\](src|dist)[/\\]/;
const HOC_NAMES = new Set(["memo", "forwardRef"]);

export default function renderDetectiveBabelPlugin(
  api: { types: typeof BabelTypes; assertVersion?: (v: number | string) => void },
): PluginObject {
  const t = api.types;
  // Babel 7 and 8 both work: only `types`, `NodePath` and the visitor shape are
  // used, all stable across the major.
  api.assertVersion?.("^7.0.0-0 || ^8.0.0-0");

  /**
   * A component is an uppercase-named function that returns JSX.
   *
   * No all-caps exclusion: it was rejecting `const A = () => <i />`, a perfectly
   * ordinary component, to guard against constants that in practice are values
   * rather than functions returning JSX — and the JSX check already covers that.
   */
  const isComponentName = (name: string | undefined | null): boolean => !!name && /^[A-Z]/.test(name);

  function returnsJsx(path: NodePath<BabelTypes.Function>): boolean {
    let found = false;
    const body = path.get("body");

    // Concise arrow body: `() => <div />` or `() => cond ? <a/> : <b/>`
    if (!Array.isArray(body) && !body.isBlockStatement()) {
      const node = (body as NodePath).node;
      return containsJsx(node);
    }

    path.traverse({
      Function(inner) {
        inner.skip(); // JSX in a nested closure belongs to that closure
      },
      ReturnStatement(ret) {
        if (ret.node.argument && containsJsx(ret.node.argument)) found = true;
      },
    });
    return found;
  }

  function containsJsx(node: BabelTypes.Node | null | undefined): boolean {
    if (!node) return false;
    if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
    if (t.isConditionalExpression(node)) return containsJsx(node.consequent) || containsJsx(node.alternate);
    if (t.isLogicalExpression(node)) return containsJsx(node.left) || containsJsx(node.right);
    if (t.isParenthesizedExpression(node)) return containsJsx(node.expression);
    if (t.isCallExpression(node)) {
      // `memo(() => <div />)` and friends
      return node.arguments.some((a) => containsJsx(a as BabelTypes.Node));
    }
    return false;
  }

  function ensureImport(path: NodePath, state: State): BabelTypes.Identifier {
    if (state.rrdLocal) return state.rrdLocal;
    const program = path.findParent((p) => p.isProgram()) as NodePath<BabelTypes.Program>;
    const local = program.scope.generateUidIdentifier("rrdTrack");
    const source = state.opts.importSource ?? DEFAULT_IMPORT_SOURCE;
    program.unshiftContainer(
      "body",
      t.importDeclaration([t.importSpecifier(local, t.identifier("withRenderDetective"))], t.stringLiteral(source)),
    );
    state.rrdLocal = local;
    return local;
  }

  function locationOf(node: BabelTypes.Node, state: State): string | undefined {
    const line = node.loc?.start.line;
    if (line === undefined || !state.rrdRelativePath) return undefined;
    return `${state.rrdRelativePath}:${line}:${(node.loc?.start.column ?? 0) + 1}`;
  }

  /** `__rrdTrack(fn, { name, source })` */
  function wrap(
    fn: BabelTypes.Expression,
    name: string,
    node: BabelTypes.Node,
    path: NodePath,
    state: State,
  ): BabelTypes.CallExpression {
    const properties: BabelTypes.ObjectProperty[] = [
      t.objectProperty(t.identifier("name"), t.stringLiteral(name)),
    ];
    const source = locationOf(node, state);
    if (source) properties.push(t.objectProperty(t.identifier("source"), t.stringLiteral(source)));
    state.rrdTouched = true;
    return t.callExpression(ensureImport(path, state), [fn, t.objectExpression(properties)]);
  }

  /** Already wrapped, by hand or by a previous pass. */
  function isAlreadyWrapped(path: NodePath): boolean {
    const parent = path.parentPath;
    if (!parent?.isCallExpression()) return false;
    const callee = parent.node.callee;
    if (t.isIdentifier(callee) && /rrdTrack|withRenderDetective/.test(callee.name)) return true;
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: "withRenderDetective" })) return true;
    return false;
  }

  return {
    name: "react-render-detective",

    pre(this: State, file: { opts: { filename?: string | null; root?: string | null } }) {
      const state = this;
      const filename = file.opts.filename ?? "";
      const root = state.opts.root ?? file.opts.root ?? process.cwd();
      state.rrdRelativePath = filename.startsWith(root) ? filename.slice(root.length).replace(/^[/\\]/, "") : filename;
    },

    visitor: {
      Program: {
        enter(path: NodePath<BabelTypes.Program>, state: State) {
          const enabled = state.opts.enabled ?? process.env.NODE_ENV !== "production";
          const filename = state.file.opts.filename ?? "";

          const skip =
            !enabled ||
            !filename ||
            /node_modules/.test(filename) ||
            SELF_PATTERN.test(filename) ||
            !matches(filename, state.opts.include, true) ||
            matches(filename, state.opts.exclude, false) ||
            (state.opts.clientOnly === true && !hasUseClient(path.node));

          if (skip) path.skip();
        },
      },

      /** `function Foo() { return <div /> }` */
      FunctionDeclaration(path: NodePath<BabelTypes.FunctionDeclaration>, state: State) {
        const id = path.node.id;
        if (!id || !isComponentName(id.name)) return;
        if (!returnsJsx(path as NodePath<BabelTypes.Function>)) return;

        /*
         * Reassign rather than rewrite the declaration: function declarations
         * hoist, and components are routinely used above their definition. A
         * `const` would turn that into a temporal dead zone error at runtime.
         * ESM export bindings are live, so `export function Foo` still exports
         * the wrapper.
         */
        const wrapped = wrap(t.cloneNode(id), id.name, path.node, path, state);
        const assignment = t.expressionStatement(t.assignmentExpression("=", t.cloneNode(id), wrapped));
        (assignment as { _rrdGenerated?: boolean })._rrdGenerated = true;

        const statementParent = path.getStatementParent();
        if (path.parentPath.isExportDefaultDeclaration() || path.parentPath.isExportNamedDeclaration()) {
          statementParent?.insertAfter(assignment);
        } else {
          path.insertAfter(assignment);
        }
        path.skip();
      },

      /** `const Foo = () => <div />` and `const Foo = memo(() => <div />)` */
      VariableDeclarator(path: NodePath<BabelTypes.VariableDeclarator>, state: State) {
        const id = path.node.id;
        const init = path.node.init;
        if (!t.isIdentifier(id) || !init || !isComponentName(id.name)) return;

        // Unwrap one level of memo()/forwardRef() so the instrumentation sits
        // inside them: memo compares props before our wrapper ever renders.
        let target: NodePath = path.get("init") as NodePath;
        if (target.isCallExpression()) {
          const callee = target.node.callee;
          const isHoc =
            (t.isIdentifier(callee) && HOC_NAMES.has(callee.name)) ||
            (t.isMemberExpression(callee) && t.isIdentifier(callee.property) && HOC_NAMES.has(callee.property.name));
          if (!isHoc) return;
          const first = (target.get("arguments") as NodePath[])[0];
          if (!first) return;
          target = first;
        }

        if (!target.isArrowFunctionExpression() && !target.isFunctionExpression()) return;
        if (isAlreadyWrapped(target)) return;
        if (!returnsJsx(target as NodePath<BabelTypes.Function>)) return;

        target.replaceWith(wrap(target.node as BabelTypes.Expression, id.name, path.node, path, state));
        path.skip();
      },

      /** `export default function () { return <div /> }` */
      ExportDefaultDeclaration(path: NodePath<BabelTypes.ExportDefaultDeclaration>, state: State) {
        const declaration = path.get("declaration");
        if (!declaration.isFunctionDeclaration() || declaration.node.id) return; // named ones are handled above
        if (!returnsJsx(declaration as NodePath<BabelTypes.Function>)) return;

        const name = componentNameFromFile(state.rrdRelativePath ?? "Default");
        const expression = t.functionExpression(
          null,
          declaration.node.params as BabelTypes.Identifier[],
          declaration.node.body,
          declaration.node.generator,
          declaration.node.async,
        );
        path.replaceWith(t.exportDefaultDeclaration(wrap(expression, name, declaration.node, path, state)));
        path.skip();
      },
    },
  };
}

function matches(filename: string, patterns: Array<string | RegExp> | undefined, whenEmpty: boolean): boolean {
  if (!patterns || patterns.length === 0) return whenEmpty;
  return patterns.some((p) => (typeof p === "string" ? filename.includes(p) : p.test(filename)));
}

function hasUseClient(program: BabelTypes.Program): boolean {
  return program.directives.some((d) => d.value.value === "use client");
}

/** `src/components/UserCard.tsx` → `UserCard` */
function componentNameFromFile(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? "Default";
  const stem = base.replace(/\.[jt]sx?$/, "");
  const cleaned = stem === "index" ? (path.split(/[/\\]/).slice(-2)[0] ?? "Default") : stem;
  const pascal = cleaned.replace(/(^|[-_.])(\w)/g, (_, __, c: string) => c.toUpperCase());
  return /^[A-Z]/.test(pascal) ? pascal : `Component${pascal}`;
}
