import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import plugin from "../src/babel/index.js";
import type { RenderDetectivePluginOptions } from "../src/babel/index.js";

const compile = (code: string, options: RenderDetectivePluginOptions = {}, filename = "/repo/src/App.tsx"): string =>
  transformSync(code, {
    filename,
    root: "/repo",
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [[plugin, { enabled: true, ...options }]],
  })?.code ?? "";

describe("what gets instrumented", () => {
  it("wraps a function declaration without breaking hoisting", () => {
    const out = compile(`
      export function Page() { return <Card />; }
      function Card() { return <div />; }
    `);
    // Reassignment, not a const rewrite: Page uses Card above its definition,
    // which a const would turn into a temporal dead zone error.
    expect(out).toContain("Card = _rrdTrack(Card,");
    expect(out).toContain("Page = _rrdTrack(Page,");
    expect(out).not.toMatch(/const Card =/);
    expect(out).toContain('import { withRenderDetective as _rrdTrack } from "react-render-detective"');
  });

  it("wraps arrow components inline", () => {
    const out = compile(`const Badge = ({ label }) => <span>{label}</span>;`);
    expect(out).toContain("const Badge = _rrdTrack(({");
    expect(out).toContain('name: "Badge"');
  });

  it("wraps inside memo and forwardRef, not outside", () => {
    const out = compile(`
      const Row = memo(function Row() { return <tr />; });
      const Input = React.forwardRef((props, ref) => <input ref={ref} />);
    `);
    // memo must keep comparing props; instrumentation belongs within it.
    expect(out).toMatch(/memo\(_rrdTrack\(function Row/);
    expect(out).toMatch(/forwardRef\(_rrdTrack\(\(props, ref\)/);
  });

  it("names an anonymous default export after its file", () => {
    const out = compile(`export default function () { return <main />; }`, {}, "/repo/src/pages/dashboard.tsx");
    expect(out).toContain('name: "Dashboard"');
    const indexed = compile(`export default function () { return <main />; }`, {}, "/repo/src/user-card/index.tsx");
    expect(indexed).toContain('name: "UserCard"');
  });

  it("attaches a source location relative to the project root", () => {
    const out = compile(`\nconst Badge = () => <span />;`);
    expect(out).toMatch(/source: "src\/App\.tsx:2:\d+"/);
  });
});

describe("what is left alone", () => {
  it("treats a single-letter component as a component", () => {
    // The uppercase-name heuristic must not quietly exclude short names.
    expect(compile(`const A = () => <i />;`)).toContain("_rrdTrack");
  });

  it("ignores functions that do not return JSX", () => {
    const out = compile(`
      function Formatter(value) { return String(value); }
      const CONSTANT = 4;
    `);
    expect(out).not.toContain("_rrdTrack");
  });

  it("ignores hooks and lowercase functions even when they return JSX", () => {
    const out = compile(`
      function useThing() { return <div />; }
      const helper = () => <span />;
    `);
    expect(out).not.toContain("_rrdTrack");
  });

  it("ignores JSX returned from a nested closure", () => {
    // The JSX belongs to the callback, not to `buildColumns`.
    const out = compile(`
      function buildColumns() { return [{ render: () => <td /> }]; }
    `);
    expect(out).not.toContain("_rrdTrack");
  });

  it("does not double-wrap what a developer wrapped by hand", () => {
    const out = compile(`
      const Card = withRenderDetective(function Card() { return <div />; }, { name: "Card" });
    `);
    expect(out.match(/_rrdTrack/g) ?? []).toHaveLength(0);
  });

  it("skips node_modules", () => {
    const out = compile(`const Badge = () => <span />;`, {}, "/repo/node_modules/lib/Badge.js");
    expect(out).not.toContain("_rrdTrack");
  });

  it("adds no import to a file it did not touch", () => {
    const out = compile(`export const total = 1 + 1;`);
    expect(out).not.toContain("react-render-detective");
  });
});

describe("configuration", () => {
  it("is inert in a production build", () => {
    const out = compile(`const Badge = () => <span />;`, { enabled: false });
    expect(out).not.toContain("_rrdTrack");
  });

  it("honours include and exclude", () => {
    expect(compile(`const A = () => <i />;`, { include: [/pages/] })).not.toContain("_rrdTrack");
    expect(compile(`const A = () => <i />;`, { include: [/App/] })).toContain("_rrdTrack");
    expect(compile(`const A = () => <i />;`, { exclude: ["App.tsx"] })).not.toContain("_rrdTrack");
  });

  it("clientOnly skips server components, which have no client render to measure", () => {
    const server = `const Page = () => <main />;`;
    const client = `"use client";\nconst Page = () => <main />;`;
    expect(compile(server, { clientOnly: true })).not.toContain("_rrdTrack");
    expect(compile(client, { clientOnly: true })).toContain("_rrdTrack");
  });

  it("can import from somewhere other than the package name", () => {
    const out = compile(`const A = () => <i />;`, { importSource: "../../src/index.js" });
    expect(out).toContain('from "../../src/index.js"');
  });
});

describe("self-instrumentation", () => {
  it("never instruments the detective's own runtime", () => {
    // Its HOC renders the component it is given; instrumenting that makes it
    // render itself and the app dies with a stack overflow before first paint.
    const code = `function RenderDetected(props) { return <Component {...props} />; }`;
    expect(compile(code, {}, "/repo/node_modules/react-render-detective/dist/index.js")).not.toContain("_rrdTrack");
    expect(compile(code, {}, "/repo/react-render-detective/src/react/withRenderDetective.tsx")).not.toContain("_rrdTrack");
  });
});

describe("nested components", () => {
  it("instruments a component declared inside another component", () => {
    // This is the whole point of remount detection: a component defined in a
    // render body is rebuilt on every parent render. It has to be seen first.
    const out = compile(`
      function Dashboard() {
        const Badge = ({ n }) => <span>{n}</span>;
        return <div><Badge n={1} /></div>;
      }
    `);
    expect(out).toContain('name: "Badge"');
    expect(out).toContain('name: "Dashboard"');
  });

  it("instruments components after a wrapped one in the same file", () => {
    const out = compile(`
      function First() { return <div />; }
      function Second() { return <div />; }
      const Third = () => <div />;
    `);
    for (const name of ["First", "Second", "Third"]) expect(out).toContain(`name: "${name}"`);
  });
});

describe("declaredInRender", () => {
  it("marks a component declared inside another component", () => {
    const out = compile(`
      function Dashboard() {
        const Badge = () => <span />;
        return <Badge />;
      }
    `);
    // Static fact from the compiler, not a runtime guess.
    expect(out).toMatch(/name: "Badge",[\s\S]*?declaredInRender: true/);
    expect(out).not.toMatch(/name: "Dashboard",[\s\S]*?declaredInRender: true/);
  });

  it("does not mark module-scope components", () => {
    const out = compile(`const Badge = () => <span />;`);
    expect(out).not.toContain("declaredInRender");
  });
});
