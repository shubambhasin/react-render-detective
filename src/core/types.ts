/** Public event & diagnostic model. Stable surface — everything else is internal. */

export type RenderPhase = "mount" | "update" | "nested-update";

export type Confidence = "high" | "medium" | "low";

/**
 * Why a render happened. `state-or-external` is deliberately fused: without React
 * internals we can prove the cause originated *inside* the component, but not
 * whether it was local state, a store subscription, or a forced update.
 */
export type RenderReason =
  | "mount"
  | "props"
  | "parent"
  | "context"
  /** Proven local state update — only reported when `useTrackedState` named it. */
  | "state"
  | "state-or-external"
  | "unknown";

export type PropChangeKind =
  /** key present in one props object only */
  | "added"
  | "removed"
  /** `Object.is` false and contents differ (or are not comparable) */
  | "value"
  /** `Object.is` false but a bounded shallow compare found identical contents */
  | "reference";

export type PropValueType =
  | "function"
  | "object"
  | "array"
  | "element"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "symbol"
  | "bigint";

/** Bounded, non-retaining representation of a value. Never a live reference. */
export type Inspected =
  | { t: "primitive"; v: string | number | boolean | null }
  | { t: "undefined" }
  | { t: "nan" }
  | { t: "symbol"; v: string }
  | { t: "bigint"; v: string }
  | { t: "function"; name: string }
  | { t: "element"; name: string }
  | { t: "array"; length: number; items?: Inspected[]; truncated?: boolean }
  | { t: "object"; ctor?: string; keys?: string[]; entries?: Record<string, Inspected>; truncated?: boolean }
  | { t: "circular" }
  | { t: "truncated"; hint: string };

export interface PropChange {
  key: string;
  kind: PropChangeKind;
  valueType: PropValueType;
  /**
   * `true`  — reference changed, bounded shallow compare says contents are identical.
   * `false` — contents genuinely differ.
   * `undefined` — not shallow-comparable (function, element, mixed types).
   */
  shallowEqual?: boolean;
  /**
   * Only set when `compareFunctionSource` is enabled and both values are
   * functions: their source text is identical, which is evidence of an inline
   * closure being recreated — not evidence that they are interchangeable.
   */
  sourceEqual?: boolean;
  previous?: Inspected;
  current?: Inspected;
}

export interface ComponentInfo {
  /** Stable per mounted instance. */
  id: string;
  name: string;
  /** Nearest *instrumented* ancestor — not necessarily the direct parent element. */
  parentId?: string;
  depth: number;
}

export interface RenderTimings {
  /** Profiler `actualDuration` — this component **and its whole subtree**. */
  subtreeDuration: number;
  /** Profiler `baseDuration` — subtree cost without memoization. */
  baseDuration: number;
  /**
   * `subtreeDuration` minus the duration of instrumented descendants that
   * rendered in the same commit. React exposes no true per-component self time,
   * so this is an **upper bound**: it still contains any *uninstrumented*
   * descendants' work.
   */
  selfDuration: number;
  /** How much descendant time was subtracted to get `selfDuration`. */
  accountedDescendantDuration: number;
  /** Shared by every component in the same React commit. */
  commitTime: number;
  startTime: number;
}

export interface Diagnosis {
  reason: RenderReason;
  confidence: Confidence;
  /** One line: what happened. */
  summary: string;
  /** Ordered supporting facts, most relevant first. */
  evidence: string[];
  /** Present only when evidence supports it. Never a blanket "add memo". */
  suggestion?: string;
  /** `true` only when observable inputs did not change at all. */
  potentiallyAvoidable: boolean;
  severity: "normal" | "monitor" | "slow" | "very-slow" | "critical";
}

export interface RenderEvent {
  id: string;
  component: ComponentInfo;
  /** ms, `performance.now()` domain. */
  timestamp: number;
  /** Committed renders only, 1-based. */
  renderNumber: number;
  phase: RenderPhase;
  timings: RenderTimings;
  changedProps: PropChange[];
  unchangedProps: string[];
  parent?: ComponentInfo;
  /** Nearest instrumented ancestor re-rendered in this same commit. */
  parentRendered: boolean;
  /**
   * The render started at this component (state, a store, or context) rather
   * than being handed down new props from above.
   */
  selfOriginated: boolean;
  /** Tracked context values that changed in this commit. */
  contextChanges: ContextChange[];
  /** State updates named via `useTrackedState`. */
  trackedState: TrackedStateChange[];
  committed: boolean;
  /**
   * Render-function invocations for this commit. `> 1` means a development
   * replay (StrictMode double-invoke or a discarded concurrent attempt).
   */
  attempts: number;
  devReplay: boolean;
  diagnosis: Diagnosis;
}

export interface ContextChange {
  contextName: string;
  changedKeys: string[];
  /** Whole value reference changed but its shallow contents did not. */
  referenceOnly: boolean;
  commitTime: number;
}

export interface ComponentStats {
  id: string;
  name: string;
  renderCount: number;
  mountCount: number;
  uncommittedAttempts: number;
  devReplays: number;
  totalSelfDuration: number;
  averageSelfDuration: number;
  medianSelfDuration: number;
  p95SelfDuration: number;
  p99SelfDuration: number;
  maxSelfDuration: number;
  slowRenders: number;
  potentiallyAvoidableRenders: number;
  reasons: Record<RenderReason, number>;
}

export interface AppStats {
  components: number;
  totalRenders: number;
  totalRenderTime: number;
  slowRenders: number;
  potentiallyAvoidableRenders: number;
  devReplays: number;
  slowest: ComponentStats[];
  mostRendered: ComponentStats[];
  mostExpensive: ComponentStats[];
}

export type Mode = "silent" | "console" | "verbose";

export interface Thresholds {
  monitor: number;
  slow: number;
  verySlow: number;
  critical: number;
}

export interface InspectionLimits {
  depth: number;
  maxObjectKeys: number;
  maxArrayLength: number;
  maxStringLength: number;
  maxSerializedNodes: number;
}

export interface DetectiveConfig {
  enabled: boolean;
  mode: Mode;
  /** Only these components are instrumented. Empty = all. */
  include: Array<string | RegExp>;
  exclude: Array<string | RegExp>;
  /** 0..1 — fraction of *components* sampled, decided once per instance. */
  samplingRate: number;
  /** Ring-buffer capacity. */
  maxEvents: number;
  /** ms. Renders at or above this are flagged slow. */
  slowRenderThreshold: number;
  thresholds: Thresholds;
  inspection: InspectionLimits;
  /** Compare function source text to spot recreated inline callbacks. Off by default. */
  compareFunctionSource: boolean;
  onEvent?: (event: RenderEvent) => void;
}

export type DetectiveOptions = Partial<Omit<DetectiveConfig, "thresholds" | "inspection">> & {
  thresholds?: Partial<Thresholds>;
  inspection?: Partial<InspectionLimits>;
};

export interface TrackedStateChange {
  /** Label passed to `useTrackedState`. */
  name: string;
  previous: Inspected;
  current: Inspected;
}
