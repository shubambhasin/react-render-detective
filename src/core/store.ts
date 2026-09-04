import { defaultConfig, detectProduction, mergeConfig, shouldInstrument } from "./config.js";
import { diffProps } from "./compare.js";
import { diagnose } from "./diagnose.js";
import { RingBuffer } from "./ringBuffer.js";
import type {
  AppStats,
  SelectorChange,
  TrackedStateChange,
  ComponentInfo,
  ComponentStats,
  ContextChange,
  DetectiveConfig,
  DetectiveOptions,
  RenderEvent,
  RenderPhase,
  RenderReason,
} from "./types.js";

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

/** What an instrumentation site reports at commit time. */
export interface CommitInput {
  phase: RenderPhase;
  subtreeDuration: number;
  baseDuration: number;
  startTime: number;
  /** `-1` when there is no Profiler; the flush pass resolves it. */
  commitTime: number;
}

export interface Lifecycle {
  mounts: number;
  unmounts: number;
  /** Mounts that followed an unmount of the same component. */
  remounts: number;
  /** When the most recent remount was observed. */
  lastRemountAt?: number;
}

/**
 * Remounts of this many distinct components inside `RELOAD_WINDOW_MS` are a
 * whole-tree rebuild — hot reload, or a route change — not a per-component bug.
 */
const RELOAD_COMPONENT_THRESHOLD = 3;
const RELOAD_WINDOW_MS = 1500;

interface DefinitionRecord {
  name: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  /** Reported by the build plugin, which knows this statically. */
  declaredInRender: boolean;
}

/** Repeated definitions inside this window mean a render loop, not hot reload. */
const INLINE_DEFINITION_WINDOW_MS = 5000;

const timestamp = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

const EMPTY_STATE: TrackedStateChange[] = [];
const EMPTY_SELECTORS: SelectorChange[] = [];
const DURATION_SAMPLE = 200;
const SWEEP_DELAY_MS = 250;

interface NodeRecord {
  id: string;
  name: string;
  /** `File.tsx:12:2` when the build plugin instrumented this component. */
  source?: string;
  /** Nearest instrumented ancestor, held directly so diagnosis never needs the registry. */
  parent?: NodeRecord;
  depth: number;
  sampled: boolean;
  /** Retained so the next render can be diffed. One props object per component. */
  prevProps?: Record<string, unknown>;
  pendingProps?: Record<string, unknown>;
  /** Render-function invocations not yet matched to a commit. */
  attempts: number;
  /** Named state updates reported by `useTrackedState`, consumed at the next commit. */
  pendingState: TrackedStateChange[];
  /** Selector value changes reported by tracked `useSelector`, consumed at the next commit. */
  pendingSelectors: SelectorChange[];
  /** Set as soon as a commit is queued, so mount detection never waits on flush. */
  seenCommit: boolean;
  /** Has this instance ever been attached? Distinguishes a real mount from a StrictMode replay. */
  everAttached?: boolean;
  /** Currently detached. Cleared if the same node re-attaches (StrictMode does exactly that). */
  detached?: boolean;
  /**
   * `useId` of the first component to call `useTrackedState` under this node.
   * Later callers (descendants) cannot claim state attribution from it.
   */
  stateOwner?: string;
  renderNumber: number;
  lastCommitTime: number;
  durations: number[];
  stats: MutableStats;
}

interface MutableStats {
  renderCount: number;
  mountCount: number;
  uncommittedAttempts: number;
  devReplays: number;
  totalSelfDuration: number;
  maxSelfDuration: number;
  slowRenders: number;
  potentiallyAvoidableRenders: number;
  reasons: Record<RenderReason, number>;
}

interface PendingCommit {
  node: NodeRecord;
  phase: RenderPhase;
  subtreeDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  attempts: number;
  /**
   * Props and state are snapshotted **at commit time**, not at flush time.
   * Several commits can land before the deferred pass runs, and reading them
   * later would diff the wrong pair.
   */
  props: Record<string, unknown> | undefined;
  state: TrackedStateChange[];
  selectors: SelectorChange[];
  seq: number;
}

const emptyReasons = (): Record<RenderReason, number> => ({
  mount: 0,
  props: 0,
  state: 0,
  store: 0,
  parent: 0,
  context: 0,
  "state-or-external": 0,
  unknown: 0,
});

export class Detective {
  config: DetectiveConfig = { ...defaultConfig };
  private nodes = new Map<string, NodeRecord>();
  private events: RingBuffer<RenderEvent>;
  private listeners = new Set<(event: RenderEvent) => void>();
  /** Registered by optional entry points so they follow clear()/reset() without being imported here. */
  private clearHooks = new Set<() => void>();
  private resetHooks = new Set<() => void>();
  private pending: PendingCommit[] = [];
  private contextChanges: Array<{ change: ContextChange; seq: number }> = [];
  /** Orders renders and context updates so they can be matched without timers. */
  private seq = 0;
  private flushScheduled = false;
  private sweepHandle: ReturnType<typeof setTimeout> | undefined;
  private nextId = 0;
  /** Mount/unmount history per component name, for remount detection. */
  private lifecycles = new Map<string, Lifecycle>();
  /** How often each component *definition* has been wrapped. */
  private definitions = new Map<string, DefinitionRecord>();
  /** Nodes created by `useRenderDiagnostics`, where props/state cannot be separated. */
  readonly hookModeNodes = new WeakSet<NodeRecord>();
  private initialized = false;

  constructor() {
    this.events = new RingBuffer<RenderEvent>(this.config.maxEvents);
  }

  /**
   * Idempotent: repeated calls reconfigure, they never duplicate anything (§47).
   *
   * Calling `init()` *is* the intent to turn diagnostics on, so `enabled`
   * defaults to true unless a production build is positively detected. Guard
   * the call itself for production safety — that is what the docs show, and it
   * is what lets a bundler drop the whole thing.
   */
  init(options: DetectiveOptions = {}): Detective {
    this.configure({ enabled: !detectProduction(), ...options });
    this.initialized = true;
    return this;
  }

  configure(options: DetectiveOptions = {}): void {
    const previousMax = this.config.maxEvents;
    this.config = mergeConfig(this.config, options);
    if (this.config.maxEvents !== previousMax) this.events.resize(this.config.maxEvents);
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  registerClearHook(hook: () => void): void {
    this.clearHooks.add(hook);
  }

  registerResetHook(hook: () => void): void {
    this.resetHooks.add(hook);
  }

  subscribe(listener: (event: RenderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------- registry

  /**
   * Creates a node without publishing it. StrictMode's double mount renders
   * discards one of the two, and only the surviving fiber's effect attaches —
   * so discarded nodes are simply garbage collected.
   */
  createNode(name: string, parent: NodeRecord | undefined, source?: string): NodeRecord | undefined {
    if (!shouldInstrument(name, this.config)) return undefined;
    const sampled = this.config.samplingRate >= 1 || Math.random() < this.config.samplingRate;
    const node: NodeRecord = {
      id: `rrd_${++this.nextId}`,
      name,
      source,
      parent,
      depth: parent ? parent.depth + 1 : 0,
      sampled,
      attempts: 0,
      pendingState: [],
      pendingSelectors: [],
      seenCommit: false,
      renderNumber: 0,
      lastCommitTime: -1,
      durations: [],
      stats: {
        renderCount: 0,
        mountCount: 0,
        uncommittedAttempts: 0,
        devReplays: 0,
        totalSelfDuration: 0,
        maxSelfDuration: 0,
        slowRenders: 0,
        potentiallyAvoidableRenders: 0,
        reasons: emptyReasons(),
      },
    };
    return node;
  }

  attach(node: NodeRecord): void {
    this.nodes.set(node.id, node);

    /*
     * StrictMode simulates an unmount by running effect cleanups and then the
     * effects again on the *same* fiber, so the same node detaches and
     * re-attaches. That is not a remount, and counting it would flag every
     * component in a StrictMode app. A real remount always produces a new node,
     * because `useState` runs afresh.
     */
    if (node.detached) {
      node.detached = false;
      const existing = this.lifecycles.get(node.name);
      if (existing) existing.unmounts--;
      return;
    }
    if (node.everAttached) return;
    node.everAttached = true;

    const life = this.lifecycleFor(node.name);
    life.mounts++;
    if (life.unmounts > 0) {
      life.remounts++;
      life.lastRemountAt = timestamp();
    }
  }

  detach(node: NodeRecord): void {
    /*
     * Registry removal only — deliberately NOT clearing `prevProps`. Wiping
     * them here made the first real update after mount diff against `{}` and
     * report every prop as newly added, because StrictMode runs cleanups on
     * components that are still mounted. Memory is bounded by dropping the node
     * from the registry: after a genuine unmount nothing references it.
     */
    this.nodes.delete(node.id);
    if (node.everAttached && !node.detached) {
      node.detached = true;
      this.lifecycleFor(node.name).unmounts++;
    }
  }

  private lifecycleFor(name: string): Lifecycle {
    let life = this.lifecycles.get(name);
    if (!life) this.lifecycles.set(name, (life = { mounts: 0, unmounts: 0, remounts: 0 }));
    return life;
  }

  /**
   * Called once per `withRenderDetective` call. A component declared at module
   * scope is wrapped once; one declared *inside* a render body is wrapped again
   * on every render of its parent — which also forces React to throw away and
   * rebuild its entire subtree. That is the signal.
   */
  noteDefinition(name: string, source: string | undefined, declaredInRender = false): void {
    const key = source ?? name;
    const now = timestamp();
    const record = this.definitions.get(key);
    if (!record) {
      this.definitions.set(key, { name, count: 1, firstSeen: now, lastSeen: now, declaredInRender });
      return;
    }
    record.count++;
    record.lastSeen = now;
    if (declaredInRender) record.declaredInRender = true;
  }

  /**
   * Is this component declared inside another component's render body?
   *
   * The build plugin answers this statically and exactly. Without it we fall
   * back to a rate heuristic — repeated definitions of the same component in a
   * short window — which is weaker: hot reload also re-defines components, and
   * a user clicking slowly stretches the window. Hence the plugin's answer wins.
   */
  inlineDefinitionSuspected(name: string): boolean {
    for (const record of this.definitions.values()) {
      if (record.name !== name) continue;
      if (record.declaredInRender) return true;
      if (record.count >= 3 && record.lastSeen - record.firstSeen < INLINE_DEFINITION_WINDOW_MS) return true;
    }
    return false;
  }

  lifecycleOf(name: string): Lifecycle {
    return this.lifecycles.get(name) ?? { mounts: 0, unmounts: 0, remounts: 0 };
  }

  /**
   * Did a whole-tree rebuild just happen?
   *
   * Hot reload is the most common cause of remounts in development, and this
   * tool only ever runs in development — so without this it would confidently
   * blame a `key` every time React Fast Refresh replaced a module. A real key
   * or inline-definition problem affects one component; a reload affects many
   * at once.
   */
  private reloadSuspectedAt(at: number): boolean {
    let names = 0;
    for (const life of this.lifecycles.values()) {
      if (life.lastRemountAt !== undefined && Math.abs(at - life.lastRemountAt) <= RELOAD_WINDOW_MS) names++;
    }
    return names >= RELOAD_COMPONENT_THRESHOLD;
  }

  /** Hot path. Must stay allocation-free and O(1). */
  recordAttempt(node: NodeRecord, props: Record<string, unknown>): void {
    node.attempts++;
    node.pendingProps = props;
  }

  recordStateChange(node: NodeRecord, change: TrackedStateChange): void {
    if (node.pendingState.length < 16) node.pendingState.push(change);
  }

  recordSelectorChange(node: NodeRecord, change: SelectorChange): void {
    if (node.pendingSelectors.length < 16) node.pendingSelectors.push(change);
  }

  /**
   * Hot path. Called from Profiler#onRender; only enqueues.
   *
   * `attempts` is the number of times the *wrapper* rendered, i.e. how often
   * this component's props were re-evaluated from above. Zero means the render
   * originated at or below this component — the flush pass works out which.
   */
  recordCommit(node: NodeRecord, commit: CommitInput): void {
    this.pending.push({
      ...commit,
      node,
      attempts: node.attempts,
      props: node.pendingProps,
      state: node.pendingState.length > 0 ? node.pendingState : EMPTY_STATE,
      selectors: node.pendingSelectors.length > 0 ? node.pendingSelectors : EMPTY_SELECTORS,
      seq: ++this.seq,
    });
    node.seenCommit = true;
    node.attempts = 0;
    node.pendingProps = undefined;
    if (node.pendingState.length > 0) node.pendingState = [];
    if (node.pendingSelectors.length > 0) node.pendingSelectors = [];
    node.lastCommitTime = commit.commitTime;
    this.scheduleFlush();
  }

  recordContextChange(change: ContextChange): void {
    this.contextChanges.push({ change, seq: ++this.seq });
    this.scheduleFlush();
  }

  // ------------------------------------------------------------ deferred work

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      try {
        this.flush();
      } catch {
        /* diagnostics must never break the app (§46) */
      }
    });
    this.scheduleSweep();
  }

  private scheduleSweep(): void {
    if (this.sweepHandle !== undefined) return;
    this.sweepHandle = setTimeout(() => {
      this.sweepHandle = undefined;
      try {
        this.sweep();
      } catch {
        /* ignore */
      }
    }, SWEEP_DELAY_MS);
    // Never keep a Node process alive for diagnostics.
    (this.sweepHandle as { unref?: () => void }).unref?.();
  }

  /** Attempts that never reached a commit were abandoned or replayed. */
  private sweep(): void {
    for (const node of this.nodes.values()) {
      if (node.attempts > 0) {
        node.stats.uncommittedAttempts += node.attempts;
        node.attempts = 0;
      }
    }
  }

  /** Runs after the commit, off the render path. Whole batch is available here. */
  flush(): void {
    if (this.pending.length === 0) {
      this.contextChanges.length = 0;
      return;
    }
    const batch = this.pending;
    this.pending = [];
    const pendingContexts = this.contextChanges;
    this.contextChanges = [];
    const hookMode = this.hookModeNodes;

    /*
     * Hook-mode records and context updates are recorded *during* render, so
     * they belong to the next commit that lands after them. Matching on
     * sequence rather than wall-clock keeps that correct even when several
     * commits queue up before this deferred pass runs.
     */
    let nextReal = -1;
    for (let i = batch.length - 1; i >= 0; i--) {
      const rec = batch[i] as PendingCommit;
      if (rec.commitTime >= 0) nextReal = rec.commitTime;
      else if (nextReal >= 0) rec.commitTime = nextReal;
      else rec.commitTime = now();
    }
    const contexts: ContextChange[] = pendingContexts.map(({ change, seq }) => {
      if (change.commitTime >= 0) return change;
      const following = batch.find((r) => r.seq > seq);
      return { ...change, commitTime: following ? following.commitTime : (batch[batch.length - 1]?.commitTime ?? now()) };
    });

    // Which nodes rendered in each commit, and how much of a node's subtree
    // time belongs to instrumented descendants.
    const commitMembers = new Map<number, Set<NodeRecord>>();
    const descendantTime = new Map<NodeRecord, number>();
    for (const rec of batch) {
      let set = commitMembers.get(rec.commitTime);
      if (!set) commitMembers.set(rec.commitTime, (set = new Set()));
      set.add(rec.node);
    }
    for (const rec of batch) {
      const parent = rec.node.parent;
      if (!parent) continue;
      if (!commitMembers.get(rec.commitTime)?.has(parent)) continue;
      descendantTime.set(parent, (descendantTime.get(parent) ?? 0) + rec.subtreeDuration);
    }

    /*
     * A Profiler fires for every ancestor of the work, so a raw callback is not
     * proof that *this* component rendered. Two facts separate them:
     *
     *   attempts > 0  the wrapper re-rendered, so something above re-rendered it.
     *   attempts = 0  the work started at or below this component.
     *
     * For the second case, an instrumented child that itself re-rendered from
     * above is proof this component rendered (it produced that child). If some
     * deeper instrumented node fired instead, the origin is down there and this
     * callback is only propagation — counting it would inflate every ancestor.
     */
    const provenSelfRender = new Set<NodeRecord>();
    const hasInstrumentedDescendant = new Set<NodeRecord>();
    for (const rec of batch) {
      const members = commitMembers.get(rec.commitTime);
      if (rec.attempts > 0 && rec.node.parent && members?.has(rec.node.parent)) {
        provenSelfRender.add(rec.node.parent);
      }
      for (let a = rec.node.parent; a; a = a.parent) {
        if (members?.has(a)) hasInstrumentedDescendant.add(a);
      }
    }

    for (const rec of batch) {
      if (!rec.node.sampled) continue;
      const counted =
        rec.attempts > 0 ||
        rec.phase === "mount" ||
        provenSelfRender.has(rec.node) ||
        !hasInstrumentedDescendant.has(rec.node);
      if (!counted) continue;
      try {
        this.emit(
          this.buildEvent(rec.node, rec, commitMembers, descendantTime, contexts, provenSelfRender, hookMode.has(rec.node)),
        );
      } catch {
        /* one bad event must not lose the batch */
      }
    }
  }

  private buildEvent(
    node: NodeRecord,
    rec: PendingCommit,
    commitMembers: Map<number, Set<NodeRecord>>,
    descendantTime: Map<NodeRecord, number>,
    contexts: ContextChange[],
    provenSelfRender: Set<NodeRecord>,
    isHookMode: boolean,
  ): RenderEvent {
    const parent = node.parent;
    const parentRendered = parent ? commitMembers.get(rec.commitTime)?.has(parent) === true : false;

    // attempts === 0 means the wrapper never re-ran, so the props object is by
    // definition the same one as last time — there is nothing to diff.
    const propsReevaluated = isHookMode ? undefined : rec.attempts > 0;
    const isMount = rec.phase === "mount";
    const props = rec.props ?? node.prevProps ?? {};
    const { changed, unchanged } =
      isMount || propsReevaluated === false
        ? { changed: [], unchanged: Object.keys(props) }
        : diffProps(node.prevProps, props, this.config);
    node.prevProps = props;

    const accounted = descendantTime.get(node) ?? 0;
    const selfDuration = Math.max(0, rec.subtreeDuration - accounted);
    const relevantContexts = contexts.filter((c) => c.commitTime === rec.commitTime);
    const trackedState = rec.state;
    const selectorChanges = rec.selectors;

    node.renderNumber++;
    const diagnosis = diagnose(
      {
        componentName: node.name,
        phase: rec.phase,
        parentName: parent?.name,
        parentRendered,
        parentUnknown: !parent,
        propsReevaluated,
        selfRenderProven: provenSelfRender.has(node),
        changedProps: changed,
        contextChanges: relevantContexts,
        selfDuration,
        attempts: rec.attempts,
        committed: true,
        trackedState,
        selectorChanges,
        remounts: this.lifecycleOf(node.name).remounts,
        inlineDefinitionSuspected: this.inlineDefinitionSuspected(node.name),
        treeReloadSuspected: rec.phase === "mount" && this.reloadSuspectedAt(timestamp()),
        priorAvoidableRenders: node.stats.potentiallyAvoidableRenders,
      },
      this.config.thresholds,
    );

    const componentInfo: ComponentInfo = {
      id: node.id,
      name: node.name,
      source: node.source,
      parentId: parent?.id,
      depth: node.depth,
    };

    const event: RenderEvent = {
      id: `${node.id}#${node.renderNumber}`,
      component: componentInfo,
      timestamp: rec.startTime,
      renderNumber: node.renderNumber,
      phase: rec.phase,
      timings: {
        subtreeDuration: rec.subtreeDuration,
        baseDuration: rec.baseDuration,
        selfDuration,
        accountedDescendantDuration: accounted,
        commitTime: rec.commitTime,
        startTime: rec.startTime,
      },
      changedProps: changed,
      unchangedProps: unchanged,
      parent: parent
        ? { id: parent.id, name: parent.name, source: parent.source, parentId: parent.parent?.id, depth: parent.depth }
        : undefined,
      parentRendered,
      selfOriginated: propsReevaluated === false,
      contextChanges: relevantContexts,
      trackedState,
      selectorChanges,
      committed: true,
      attempts: Math.max(1, rec.attempts),
      devReplay: rec.attempts > 1,
      diagnosis,
    };

    this.updateStats(node, event);
    return event;
  }

  private updateStats(node: NodeRecord, event: RenderEvent): void {
    const s = node.stats;
    s.renderCount++;
    if (event.phase === "mount") s.mountCount++;
    if (event.devReplay) s.devReplays++;
    const d = event.timings.selfDuration;
    s.totalSelfDuration += d;
    if (d > s.maxSelfDuration) s.maxSelfDuration = d;
    if (d >= this.config.slowRenderThreshold) s.slowRenders++;
    if (event.diagnosis.potentiallyAvoidable) s.potentiallyAvoidableRenders++;
    s.reasons[event.diagnosis.reason]++;
    node.durations.push(d);
    if (node.durations.length > DURATION_SAMPLE) node.durations.shift();
  }

  private emit(event: RenderEvent): void {
    this.events.push(event);
    const { onEvent } = this.config;
    if (onEvent) {
      try {
        onEvent(event);
      } catch {
        /* ignore */
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  }

  // -------------------------------------------------------------------- query

  getEvents(): RenderEvent[] {
    this.flush();
    return this.events.toArray();
  }

  getComponentStats(name?: string): ComponentStats[] {
    this.flush();
    const out: ComponentStats[] = [];
    for (const node of this.nodes.values()) {
      if (name && node.name !== name) continue;
      if (node.stats.renderCount === 0 && node.stats.uncommittedAttempts === 0) continue;
      out.push(toStats(node, this.lifecycleOf(node.name)));
    }
    return out;
  }

  getStats(): AppStats {
    const all = this.getComponentStats();
    const byName = new Map<string, ComponentStats>();
    for (const s of all) {
      const existing = byName.get(s.name);
      byName.set(s.name, existing ? mergeStats(existing, s) : s);
    }
    const merged = [...byName.values()];
    return {
      components: merged.length,
      totalRenders: merged.reduce((a, s) => a + s.renderCount, 0),
      totalRenderTime: merged.reduce((a, s) => a + s.totalSelfDuration, 0),
      slowRenders: merged.reduce((a, s) => a + s.slowRenders, 0),
      potentiallyAvoidableRenders: merged.reduce((a, s) => a + s.potentiallyAvoidableRenders, 0),
      devReplays: merged.reduce((a, s) => a + s.devReplays, 0),
      slowest: [...merged].sort((a, b) => b.maxSelfDuration - a.maxSelfDuration).slice(0, 10),
      mostRendered: [...merged].sort((a, b) => b.renderCount - a.renderCount).slice(0, 10),
      mostExpensive: [...merged].sort((a, b) => b.totalSelfDuration - a.totalSelfDuration).slice(0, 10),
    };
  }

  clear(): void {
    for (const hook of this.clearHooks) {
      try {
        hook();
      } catch {
        /* ignore */
      }
    }
    this.events.clear();
    this.pending.length = 0;
    this.contextChanges.length = 0;
    for (const node of this.nodes.values()) {
      node.stats = {
        renderCount: 0,
        mountCount: 0,
        uncommittedAttempts: 0,
        devReplays: 0,
        totalSelfDuration: 0,
        maxSelfDuration: 0,
        slowRenders: 0,
        potentiallyAvoidableRenders: 0,
        reasons: emptyReasons(),
      };
      node.durations.length = 0;
      node.renderNumber = 0;
    }
  }

  /** Full teardown — used by tests and by HMR disposal. */
  reset(): void {
    for (const hook of this.resetHooks) {
      try {
        hook();
      } catch {
        /* ignore */
      }
    }
    this.resetHooks.clear();
    this.clear();
    this.clearHooks.clear();
    this.nodes.clear();
    this.lifecycles.clear();
    this.definitions.clear();
    this.listeners.clear();
    if (this.sweepHandle !== undefined) clearTimeout(this.sweepHandle);
    this.sweepHandle = undefined;
    this.config = { ...defaultConfig };
    this.events.resize(this.config.maxEvents);
    this.initialized = false;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

function toStats(node: NodeRecord, lifecycle: Lifecycle): ComponentStats {
  const sorted = [...node.durations].sort((a, b) => a - b);
  const s = node.stats;
  return {
    id: node.id,
    name: node.name,
    source: node.source,
    renderCount: s.renderCount,
    mountCount: s.mountCount,
    remountCount: lifecycle.remounts,
    uncommittedAttempts: s.uncommittedAttempts,
    devReplays: s.devReplays,
    totalSelfDuration: s.totalSelfDuration,
    averageSelfDuration: s.renderCount ? s.totalSelfDuration / s.renderCount : 0,
    medianSelfDuration: percentile(sorted, 50),
    p95SelfDuration: percentile(sorted, 95),
    p99SelfDuration: percentile(sorted, 99),
    maxSelfDuration: s.maxSelfDuration,
    slowRenders: s.slowRenders,
    potentiallyAvoidableRenders: s.potentiallyAvoidableRenders,
    reasons: { ...s.reasons },
  };
}

function mergeStats(a: ComponentStats, b: ComponentStats): ComponentStats {
  const renderCount = a.renderCount + b.renderCount;
  const total = a.totalSelfDuration + b.totalSelfDuration;
  const reasons = { ...a.reasons };
  for (const key of Object.keys(b.reasons) as RenderReason[]) reasons[key] += b.reasons[key];
  return {
    id: a.id,
    name: a.name,
    source: a.source ?? b.source,
    renderCount,
    mountCount: a.mountCount + b.mountCount,
    remountCount: Math.max(a.remountCount, b.remountCount),
    uncommittedAttempts: a.uncommittedAttempts + b.uncommittedAttempts,
    devReplays: a.devReplays + b.devReplays,
    totalSelfDuration: total,
    averageSelfDuration: renderCount ? total / renderCount : 0,
    medianSelfDuration: Math.max(a.medianSelfDuration, b.medianSelfDuration),
    p95SelfDuration: Math.max(a.p95SelfDuration, b.p95SelfDuration),
    p99SelfDuration: Math.max(a.p99SelfDuration, b.p99SelfDuration),
    maxSelfDuration: Math.max(a.maxSelfDuration, b.maxSelfDuration),
    slowRenders: a.slowRenders + b.slowRenders,
    potentiallyAvoidableRenders: a.potentiallyAvoidableRenders + b.potentiallyAvoidableRenders,
    reasons,
  };
}

export type { NodeRecord };

/**
 * Singleton pinned to globalThis so Fast Refresh / duplicate module instances
 * share one detective instead of stacking three copies of the debugger (§47).
 */
const KEY = Symbol.for("react-render-detective.instance");
type Global = typeof globalThis & { [KEY]?: Detective };

export function getDetective(): Detective {
  const g = globalThis as Global;
  if (!g[KEY]) g[KEY] = new Detective();
  return g[KEY] as Detective;
}
