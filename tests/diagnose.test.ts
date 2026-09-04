import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { diagnose, severityFor } from "../src/core/diagnose.js";
import type { DiagnosisInput } from "../src/core/diagnose.js";
import type { PropChange } from "../src/core/types.js";

const t = defaultConfig.thresholds;

const input = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  componentName: "UserProfile",
  phase: "update",
  parentName: "Dashboard",
  parentRendered: false,
  parentUnknown: false,
  propsReevaluated: true,
  selfRenderProven: false,
  changedProps: [],
  contextChanges: [],
  trackedState: [],
  remounts: 0,
  inlineDefinitionSuspected: false,
  treeReloadSuspected: false,
  selfDuration: 2,
  attempts: 1,
  committed: true,
  priorAvoidableRenders: 0,
  ...over,
});

const prop = (over: Partial<PropChange>): PropChange => ({
  key: "user",
  kind: "value",
  valueType: "object",
  ...over,
});

describe("diagnostic accuracy fixtures", () => {
  it("mount is reported as mount, never as waste", () => {
    const d = diagnose(input({ phase: "mount" }), t);
    expect(d.reason).toBe("mount");
    expect(d.potentiallyAvoidable).toBe(false);
  });

  it("names an inline component definition as the cause of repeated remounts", () => {
    const d = diagnose(input({ phase: "mount", remounts: 6, inlineDefinitionSuspected: true }), t);
    expect(d.reason).toBe("mount");
    expect(d.confidence).toBe("high");
    expect(d.potentiallyAvoidable).toBe(true);
    expect(d.summary).toContain("rebuilt, not re-rendered");
    expect(d.suggestion).toContain("out of its parent's render body");
  });

  it("blames a hot reload, not the key, when many components remount together", () => {
    // The tool is dev-only, so Fast Refresh is the most common remount cause it
    // will ever see. Blaming `key` for it would be wrong several times an hour.
    const d = diagnose(input({ phase: "mount", remounts: 20, treeReloadSuspected: true }), t);
    expect(d.confidence).toBe("low");
    expect(d.potentiallyAvoidable).toBe(false);
    expect(d.summary).toContain("hot reload or a route change");
    expect(d.suggestion).not.toContain("`key`");
  });

  it("still blames the inline definition even during a reload", () => {
    // A component defined in a render body is a real bug regardless.
    const d = diagnose(
      input({ phase: "mount", remounts: 20, treeReloadSuspected: true, inlineDefinitionSuspected: true }),
      t,
    );
    expect(d.confidence).toBe("high");
    expect(d.suggestion).toContain("out of its parent's render body");
  });

  it("points at key churn when the definition is stable", () => {
    const d = diagnose(input({ phase: "mount", remounts: 6, inlineDefinitionSuspected: false }), t);
    expect(d.confidence).toBe("medium");
    expect(d.evidence.join(" ")).toContain("element identity");
    expect(d.suggestion).toContain("`key`");
  });

  it("does not cry remount over ordinary mounting", () => {
    // A growing list mounts components; that is not a defect.
    const d = diagnose(input({ phase: "mount", remounts: 1 }), t);
    expect(d.summary).toBe("UserProfile mounted.");
    expect(d.potentiallyAvoidable).toBe(false);
  });

  it("a real value change is `props` at high confidence and is NOT avoidable", () => {
    const d = diagnose(input({ changedProps: [prop({ kind: "value", shallowEqual: false })] }), t);
    expect(d.reason).toBe("props");
    expect(d.confidence).toBe("high");
    expect(d.potentiallyAvoidable).toBe(false);
  });

  it("a reference-only change is flagged avoidable and names the parent", () => {
    const d = diagnose(
      input({
        parentRendered: true,
        changedProps: [prop({ kind: "reference", shallowEqual: true })],
      }),
      t,
    );
    expect(d.reason).toBe("props");
    expect(d.potentiallyAvoidable).toBe(true);
    expect(d.summary).toContain("by reference");
    expect(d.evidence.join(" ")).toContain("Dashboard");
    expect(d.suggestion).toContain("useMemo");
  });

  it("an unstable callback suggests useCallback, not a blanket memo", () => {
    const d = diagnose(
      input({ changedProps: [prop({ key: "onSave", kind: "reference", valueType: "function" })] }),
      t,
    );
    expect(d.suggestion).toContain("useCallback");
    expect(d.suggestion).not.toContain("React.memo");
  });

  it("a mix of real and reference-only changes is reported as a real prop change", () => {
    const d = diagnose(
      input({
        changedProps: [
          prop({ key: "id", kind: "value", valueType: "number" }),
          prop({ key: "style", kind: "reference", shallowEqual: true }),
        ],
      }),
      t,
    );
    expect(d.reason).toBe("props");
    expect(d.potentiallyAvoidable).toBe(false);
    expect(d.evidence.join(" ")).toContain("style");
  });

  it("identical props + parent rendered = parent propagation at high confidence", () => {
    const d = diagnose(input({ parentRendered: true }), t);
    expect(d.reason).toBe("parent");
    expect(d.confidence).toBe("high");
    expect(d.potentiallyAvoidable).toBe(true);
  });

  it("does not push React.memo for a cheap, rarely-repeated render", () => {
    const d = diagnose(input({ parentRendered: true, selfDuration: 0.2 }), t);
    expect(d.suggestion).toContain("unlikely to pay for itself");
  });

  it("suggests measuring React.memo once the pattern repeats", () => {
    const d = diagnose(input({ parentRendered: true, selfDuration: 0.2, priorAvoidableRenders: 9 }), t);
    expect(d.suggestion).toContain("React.memo");
    expect(d.suggestion).toContain("measure");
  });

  it("proves a self-originated render when an instrumented child re-rendered", () => {
    const proven = diagnose(input({ propsReevaluated: false, selfRenderProven: true }), t);
    expect(proven.reason).toBe("state-or-external");
    expect(proven.confidence).toBe("high");

    const unproven = diagnose(input({ propsReevaluated: false, selfRenderProven: false }), t);
    expect(unproven.confidence).toBe("medium");
    expect(unproven.evidence.join(" ")).toContain("uninstrumented descendant");
  });

  it("admits when an uninstrumented component sits between parent and child", () => {
    const d = diagnose(input({ propsReevaluated: true, parentRendered: false }), t);
    expect(d.reason).toBe("parent");
    expect(d.confidence).toBe("medium");
    expect(d.evidence.join(" ")).toContain("uninstrumented component sits in between");
  });

  it("a context update is medium confidence and states the limitation", () => {
    const d = diagnose(
      input({
        propsReevaluated: false,
        contextChanges: [{ contextName: "ThemeContext", changedKeys: ["theme"], referenceOnly: false, commitTime: 1 }],
      }),
      t,
    );
    expect(d.reason).toBe("context");
    expect(d.confidence).toBe("medium");
    expect(d.evidence.join(" ")).toContain("correlation");
    expect(d.potentiallyAvoidable).toBe(false);
  });

  it("named state wins over every other explanation, at high confidence", () => {
    const d = diagnose(
      input({
        parentRendered: true,
        trackedState: [{ name: "count", previous: { t: "primitive", v: 1 }, current: { t: "primitive", v: 2 } }],
      }),
      t,
    );
    expect(d.reason).toBe("state");
    expect(d.confidence).toBe("high");
    expect(d.potentiallyAvoidable).toBe(false);
  });

  it("falls back to state-or-external by elimination, admitting it cannot tell which", () => {
    const d = diagnose(input({ propsReevaluated: false }), t);
    expect(d.reason).toBe("state-or-external");
    expect(d.confidence).toBe("medium");
    expect(d.evidence.join(" ")).toContain("not observable");
  });

  it("says so plainly when there is no instrumented ancestor to rule out", () => {
    const d = diagnose(input({ propsReevaluated: undefined, parentUnknown: true, parentName: undefined }), t);
    expect(d.reason).toBe("unknown");
    expect(d.confidence).toBe("low");
    expect(d.summary).toContain("could not be determined reliably");
  });

  it("labels a development replay instead of doubling the render count", () => {
    const d = diagnose(input({ attempts: 2, parentRendered: true }), t);
    expect(d.evidence.join(" ")).toContain("StrictMode");
    expect(d.evidence.join(" ")).toContain("Not production behaviour");
  });

  it("marks uncommitted work as discarded", () => {
    const d = diagnose(input({ committed: false }), t);
    expect(d.evidence[0]).toContain("not committed");
  });

  it("maps duration onto the configured severity bands", () => {
    expect(severityFor(1, t)).toBe("normal");
    expect(severityFor(8, t)).toBe("monitor");
    expect(severityFor(20, t)).toBe("slow");
    expect(severityFor(60, t)).toBe("very-slow");
    expect(severityFor(200, t)).toBe("critical");
    expect(severityFor(20, { monitor: 10, slow: 40, verySlow: 80, critical: 200 })).toBe("monitor");
  });
});
