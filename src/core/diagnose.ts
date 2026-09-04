import { formatInspected } from "./inspect.js";
import type {
  Confidence,
  ContextChange,
  SelectorChange,
  TrackedStateChange,
  Diagnosis,
  PropChange,
  RenderPhase,
  Thresholds,
} from "./types.js";

export interface DiagnosisInput {
  componentName: string;
  phase: RenderPhase;
  parentName?: string;
  /** Nearest instrumented ancestor re-rendered in this same commit. */
  parentRendered: boolean;
  /** True when we have no instrumented ancestor, so `parentRendered` is unknown. */
  parentUnknown: boolean;
  /**
   * Did something above re-evaluate this component's props?
   * `true`  — the wrapper re-rendered, so the render came from above.
   * `false` — it did not, so the render started here or below.
   * `undefined` — hook mode, where the two cannot be told apart.
   */
  propsReevaluated: boolean | undefined;
  /** An instrumented child re-rendered from above, proving this component rendered. */
  selfRenderProven: boolean;
  changedProps: PropChange[];
  contextChanges: ContextChange[];
  /** Named state updates from `useTrackedState`. Empty unless opted in. */
  trackedState: TrackedStateChange[];
  /** External-store selector values that changed. Empty unless selectors are tracked. */
  selectorChanges: SelectorChange[];
  /** How many times this component has been rebuilt rather than re-rendered. */
  remounts: number;
  /** The component looks like it is declared inside another component's render body. */
  inlineDefinitionSuspected: boolean;
  /** Many components remounted at once — a hot reload or a route change. */
  treeReloadSuspected: boolean;
  selfDuration: number;
  attempts: number;
  committed: boolean;
  /** How many times this component already produced a "no observable change" render. */
  priorAvoidableRenders: number;
}

export function severityFor(duration: number, t: Thresholds): Diagnosis["severity"] {
  if (duration >= t.critical) return "critical";
  if (duration >= t.verySlow) return "very-slow";
  if (duration >= t.slow) return "slow";
  if (duration >= t.monitor) return "monitor";
  return "normal";
}

/**
 * Pure. No React, no globals, no I/O — so diagnostic correctness can be tested
 * directly (§70).
 */
export function diagnose(input: DiagnosisInput, thresholds: Thresholds): Diagnosis {
  const severity = severityFor(input.selfDuration, thresholds);
  const d = classify(input);
  d.severity = severity;

  if (!input.committed) {
    d.evidence.unshift(
      "This render attempt was not committed — React discarded it (concurrent interruption or a development replay). It is excluded from statistics.",
    );
  } else if (input.attempts > 1) {
    d.evidence.push(
      `Render function ran ${input.attempts}× for one commit — a development replay (StrictMode double-invoke or a discarded attempt). Not production behaviour.`,
    );
  }

  if (severity === "critical" || severity === "very-slow") {
    d.evidence.push(`Render cost ${fmt(input.selfDuration)} — above the ${thresholds.verySlow}ms threshold.`);
  }
  return d;
}

function classify(input: DiagnosisInput): Diagnosis {
  const { changedProps, contextChanges, parentRendered, parentUnknown, parentName } = input;

  if (input.phase === "mount") {
    /*
     * A remount is not a render: React threw the previous instance away, along
     * with its DOM and all of its state, and built a new one. It costs far more
     * than any re-render, so it is worth saying loudly — but only when it has
     * actually happened repeatedly, since mounting is also just what happens
     * when a list grows or a route changes.
     */
    /*
     * Hot reload rebuilds the tree, and this tool only runs in development, so
     * this is the most frequent cause of remounts it will ever see. Blaming a
     * `key` for it would be confidently wrong several times an hour.
     */
    if (input.remounts >= 2 && input.treeReloadSuspected && !input.inlineDefinitionSuspected) {
      return make(
        "mount",
        "low",
        `${input.componentName} was rebuilt along with several other components — most likely a hot reload or a route change.`,
        [
          `${input.componentName} has been remounted ${input.remounts}× in total.`,
          "Several unrelated components remounted at the same moment, which is what a whole-tree rebuild looks like — React Fast Refresh replacing a module, or a route unmounting.",
          "A per-component remount problem affects one component, not many at once.",
        ],
        false,
        "Nothing to fix if this followed an edit or a navigation. Reload the page and repeat the interaction to measure without it.",
      );
    }

    if (input.remounts >= 2) {
      const inline = input.inlineDefinitionSuspected;
      return make(
        "mount",
        inline ? "high" : "medium",
        `${input.componentName} was rebuilt, not re-rendered — this is remount ${input.remounts + 1}.`,
        [
          `This component has been unmounted and mounted again ${input.remounts}× — its DOM and all of its state were discarded each time.`,
          inline
            ? "Its definition is being re-created repeatedly in a short window, which means it is declared *inside* another component's render body. React sees a new component type on every parent render and cannot reuse anything."
            : "Its definition is stable, so the remounts come from the element identity changing — usually a changing `key`, or the component moving between branches of a conditional.",
          "A remount is much more expensive than a re-render, and it resets state.",
        ],
        true,
        inline
          ? `Move ${input.componentName} out of its parent's render body to module scope. Defining a component inside another component makes React discard and rebuild the whole subtree on every parent render.`
          : `Check the \`key\` given to ${input.componentName}, and whether it is being rendered from a different branch each time.`,
      );
    }
    return make("mount", "high", `${input.componentName} mounted.`, ["First render of this instance."], false);
  }

  /*
   * A tracked selector is direct evidence, so it outranks everything except a
   * named local state update. Before this existed, a Redux-driven render could
   * only ever be reported as "state or an external store" — which is where the
   * tool stopped being useful on a real application, since that covers the
   * majority of renders in most React codebases.
   */
  if (input.selectorChanges.length > 0) {
    const changes = input.selectorChanges;
    const unstable = changes.filter((c) => c.referenceOnly);
    const names = changes.map((c) => c.name);

    const evidence = changes.map(
      (c) =>
        `\`${c.name}\`${c.source ? ` (${c.source})` : ""}: ${formatInspected(c.previous)} → ${formatInspected(c.current)}` +
        (c.referenceOnly ? "  — new reference, identical contents" : ""),
    );

    if (unstable.length > 0) {
      /*
       * The classic Redux performance bug: a selector that builds a new object
       * or array on every call. `useSelector` compares with `Object.is`, so the
       * component re-renders on *every* store update, whatever changed.
       */
      const worst = unstable[0] as SelectorChange;
      evidence.push(
        "useSelector compares with Object.is, so a selector that builds a new value each call re-renders the component on every store update — not only when its data changes.",
      );
      return make(
        "store",
        "high",
        `${input.componentName} rendered because ${unstable.map((c) => `\`${c.name}\``).join(", ")} returned a new reference with identical contents.`,
        evidence,
        true,
        `Make \`${worst.name}\`${worst.source ? ` at ${worst.source}` : ""} return a stable value: select the raw slice and derive outside the selector, memoize it with createSelector, or pass an equality function such as shallowEqual.`,
      );
    }

    return make(
      "store",
      "high",
      `${input.componentName} rendered because ${names.join(", ")} changed in the store.`,
      [...evidence, "The values genuinely changed, so this render is doing real work."],
      false,
    );
  }

  if (input.trackedState.length > 0) {
    const names = input.trackedState.map((s) => s.name);
    const evidence = input.trackedState.map(
      (s) => `\`${s.name}\`: ${formatInspected(s.previous)} → ${formatInspected(s.current)}`,
    );
    if (changedProps.length > 0) {
      evidence.push(`Props also changed: ${changedProps.map((c) => c.key).join(", ")}.`);
    }
    return make(
      "state",
      "high",
      `${input.componentName} rendered because its own state changed: ${names.join(", ")}.`,
      evidence,
      false,
    );
  }

  if (changedProps.length > 0) {
    const meaningful = changedProps.filter((c) => c.kind !== "reference");
    const referenceOnly = changedProps.filter((c) => c.kind === "reference");

    if (meaningful.length > 0) {
      const keys = meaningful.map((c) => c.key);
      const evidence = [
        `Props changed with new values: ${keys.join(", ")}.`,
        ...meaningful.map(describe),
      ];
      if (referenceOnly.length > 0) {
        evidence.push(
          `Also changed by reference only (contents identical): ${referenceOnly.map((c) => c.key).join(", ")}.`,
        );
      }
      return make(
        "props",
        "high",
        `${input.componentName} rendered because ${plural(keys.length, "prop")} changed: ${keys.join(", ")}.`,
        evidence,
        false,
        referenceOnly.length > 0 ? stabiliseSuggestion(referenceOnly, parentName) : undefined,
      );
    }

    // Every changed prop is a reference change with equal (or unknown) contents.
    const keys = referenceOnly.map((c) => c.key);
    const evidence = [
      `${plural(keys.length, "prop")} changed by reference only: ${keys.join(", ")}.`,
      ...referenceOnly.map(describe),
    ];
    if (parentRendered && parentName) {
      evidence.push(`${parentName} re-rendered in the same commit and recreated ${keys.length > 1 ? "these values" : `\`${keys[0]}\``}.`);
    }
    const confidence: Confidence = referenceOnly.some((c) => c.shallowEqual === true || c.valueType === "function")
      ? "medium"
      : "low";
    return make(
      "props",
      confidence,
      `${input.componentName} rendered because ${keys.join(", ")} changed by reference — the contents did not.`,
      evidence,
      true,
      stabiliseSuggestion(referenceOnly, parentName),
    );
  }

  // Nothing about the props changed.
  if (input.propsReevaluated === false) {
    // The wrapper never re-ran: no new props came from above, so the render
    // began at this component or below it.
    if (contextChanges.length > 0) {
      const c = contextChanges[0] as ContextChange;
      const detail = c.changedKeys.length > 0 ? ` Changed: ${c.changedKeys.join(", ")}.` : "";
      return make(
        "context",
        "medium",
        `${input.componentName} rendered after ${c.contextName} updated in the same commit.${detail}`,
        [
          "No new props came from above — the render started at this component.",
          `Tracked context ${c.contextName} changed in this commit.`,
          c.referenceOnly
            ? `${c.contextName}'s value changed by reference only — its contents are identical.`
            : `${c.contextName}'s contents changed.`,
          "React does not expose which contexts a component subscribes to, so this is correlation within one commit, not a recorded subscription.",
        ],
        c.referenceOnly,
        c.referenceOnly
          ? `${c.contextName}'s provider recreates its value every render. Stabilise it with useMemo if consumers are doing real work.`
          : undefined,
      );
    }
    return make(
      "state-or-external",
      input.selfRenderProven ? "high" : "medium",
      `${input.componentName} rendered from inside itself — local state, a store subscription, or a forced update.`,
      [
        "No new props came from above: the wrapper did not re-render.",
        input.selfRenderProven
          ? "An instrumented child re-rendered from above in this commit, which proves this component produced it."
          : "No instrumented descendant rendered in this commit, so an uninstrumented descendant could in principle be the origin instead.",
        "React does not expose hook state without private internals, so the exact source is not observable. Use useTrackedState to name local state, and the build plugin's store tracking to name selectors.",
      ],
      false,
    );
  }

  if (input.propsReevaluated === true) {
    // The wrapper re-rendered with identical props — pure propagation.
    const known = parentRendered && parentName;
    return make(
      "parent",
      known && contextChanges.length === 0 ? "high" : "medium",
      `${input.componentName} rendered because its parent rendered — its own inputs did not change.`,
      [
        known
          ? `${parentName} re-rendered in this commit.`
          : "Something above re-rendered this component, but the nearest instrumented ancestor did not — an uninstrumented component sits in between.",
        "Every prop is identical by reference.",
        contextChanges.length === 0
          ? "No tracked context changed in this commit."
          : `A tracked context also changed (${contextChanges.map((c) => c.contextName).join(", ")}) — but new props arrived from above, so propagation is the direct cause.`,
      ],
      true,
      memoSuggestion(input),
    );
  }

  // Hook mode: props and self-originated renders cannot be told apart.
  if (parentRendered) {
    const evidence = [
      `${parentName ?? "The nearest instrumented ancestor"} re-rendered in this commit.`,
      "Every prop is identical by reference.",
      contextChanges.length === 0
        ? "No tracked context changed in this commit."
        : `A tracked context also changed (${contextChanges.map((c) => c.contextName).join(", ")}) — if this component consumes it, that is an alternative cause.`,
    ];
    return make(
      "parent",
      contextChanges.length === 0 ? "high" : "medium",
      `${input.componentName} rendered because its parent rendered — its own inputs did not change.`,
      evidence,
      true,
      memoSuggestion(input),
    );
  }

  if (contextChanges.length > 0) {
    const c = contextChanges[0] as ContextChange;
    const detail = c.changedKeys.length > 0 ? ` Changed: ${c.changedKeys.join(", ")}.` : "";
    return make(
      "context",
      "medium",
      `${input.componentName} rendered after ${c.contextName} updated in the same commit.${detail}`,
      [
        `Props are identical and the parent did not re-render.`,
        `Tracked context ${c.contextName} changed in this commit.`,
        c.referenceOnly
          ? `${c.contextName}'s value changed by reference only — its contents are identical.`
          : `${c.contextName}'s contents changed.`,
        "React does not expose which contexts a component subscribes to, so this is correlation within one commit, not a recorded subscription.",
      ],
      c.referenceOnly,
      c.referenceOnly
        ? `${c.contextName}'s provider recreates its value every render. Stabilise it with useMemo if consumers are doing real work.`
        : undefined,
    );
  }

  if (parentUnknown) {
    return make(
      "unknown",
      "low",
      `Cause could not be determined reliably for ${input.componentName}.`,
      [
        "Props are identical and no tracked context changed.",
        "This component has no instrumented ancestor, so a parent-propagated render cannot be ruled out.",
        "Instrument the parent, or track the context it consumes, to narrow this down.",
      ],
      false,
    );
  }

  return make(
    "state-or-external",
    "medium",
    `${input.componentName} rendered from inside itself — local state, a store subscription, or a forced update.`,
    [
      "Props are identical by reference.",
      "The nearest instrumented ancestor did not re-render in this commit.",
      "No tracked context changed in this commit.",
      "React does not expose hook state without private internals, so the exact source is not observable. Use useTrackedState to name it.",
    ],
    false,
  );
}

/**
 * Memoization is a trade, not a default. Only recommend measuring it when the
 * render actually costs something or the pattern has repeated (§50, §52).
 */
function memoSuggestion(input: DiagnosisInput): string {
  const worth = input.selfDuration >= 1 || input.priorAvoidableRenders >= 5;
  return worth
    ? `Check whether ${input.componentName} benefits from React.memo(). It has re-rendered with identical props ${input.priorAvoidableRenders + 1}× at ${fmt(input.selfDuration)} each — measure before and after.`
    : `Props are identical, but this render costs ${fmt(input.selfDuration)}. Memoizing is unlikely to pay for itself yet.`;
}

function stabiliseSuggestion(changes: PropChange[], parentName?: string): string {
  const fns = changes.filter((c) => c.valueType === "function").map((c) => c.key);
  const objs = changes.filter((c) => c.valueType === "object" || c.valueType === "array").map((c) => c.key);
  const where = parentName ? ` in ${parentName}` : "";
  const parts: string[] = [];
  if (fns.length > 0) parts.push(`${list(fns)} ${plural(fns.length, "is", "are")} recreated on every render${where} — useCallback, or hoist it, if a memoized child depends on it`);
  if (objs.length > 0) parts.push(`${list(objs)} ${plural(objs.length, "is", "are")} a new object each render${where} — useMemo it, or pass the primitive fields you actually use`);
  if (parts.length === 0) return `Find where ${list(changes.map((c) => c.key))} is created${where} and stabilise it.`;
  return `${capitalize(parts.join("; "))}.`;
}

function describe(c: PropChange): string {
  switch (c.kind) {
    case "added":
      return `\`${c.key}\` was added.`;
    case "removed":
      return `\`${c.key}\` was removed.`;
    case "reference":
      if (c.valueType === "function") {
        return c.sourceEqual
          ? `\`${c.key}\` is a new function with identical source — an inline closure recreated by the parent.`
          : `\`${c.key}\` is a new function reference.`;
      }
      if (c.shallowEqual === true) return `\`${c.key}\` is a new ${c.valueType} whose shallow contents are identical.`;
      return `\`${c.key}\` changed reference; contents were too large or too exotic to compare cheaply.`;
    case "value":
      return `\`${c.key}\` changed value.`;
  }
}

function make(
  reason: Diagnosis["reason"],
  confidence: Confidence,
  summary: string,
  evidence: string[],
  potentiallyAvoidable: boolean,
  suggestion?: string,
): Diagnosis {
  return { reason, confidence, summary, evidence, potentiallyAvoidable, suggestion, severity: "normal" };
}

const fmt = (ms: number): string => `${ms.toFixed(1)}ms`;
const list = (xs: string[]): string => xs.map((x) => `\`${x}\``).join(", ");
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
function plural(n: number, one: string, many?: string): string {
  if (one === "is") return n === 1 ? "is" : (many as string);
  return n === 1 ? `${one}` : `${one}s`;
}
