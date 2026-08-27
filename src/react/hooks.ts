import * as React from "react";
import { useContext, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { getDetective } from "../core/store.js";
import { inspect } from "../core/inspect.js";
import { diffProps, shallowEqual } from "../core/compare.js";
import type { RenderEvent } from "../core/types.js";
import { AncestryContext } from "./ancestry.js";

/**
 * In-component diagnostics without wrapping.
 *
 * Limitation, by design: a hook cannot install a `<Profiler>` around its own
 * component, so **no duration is available in this mode** — timings are
 * reported as 0. Everything else (render count, prop diffing, parent
 * attribution) is as accurate as the HOC.
 */
export function useRenderDiagnostics(name: string, props?: Record<string, unknown>): RenderEvent | undefined {
  const detective = getDetective();
  const parent = useContext(AncestryContext);
  const [node] = useState(() => {
    if (!detective.enabled) return undefined;
    const created = detective.createNode(name, parent);
    if (created) detective.hookModeNodes.add(created);
    return created;
  });
  const last = useRef<RenderEvent | undefined>(undefined);

  useEffect(() => {
    if (!node) return;
    detective.attach(node);
    const unsubscribe = detective.subscribe((event) => {
      if (event.component.id === node.id) last.current = event;
    });
    return () => {
      unsubscribe();
      detective.detach(node);
    };
  }, [detective, node]);

  if (node) {
    const isMount = !node.seenCommit;
    detective.recordAttempt(node, props ?? {});
    // No Profiler in hook mode: enqueue with a sentinel commit time, which the
    // flush pass resolves to the next real commit that follows this render.
    detective.recordCommit(node, {
      phase: isMount ? "mount" : "update",
      subtreeDuration: 0,
      baseDuration: 0,
      startTime: 0,
      commitTime: -1,
    });
  }

  return last.current;
}

/**
 * React 18+. Used only to identify *which* component under an instrumented node
 * owns the tracked state; `useId` is stable across StrictMode's double render,
 * which a `useRef` token would not be. Older React simply loses the guard.
 */
const useOwnerId: () => string =
  typeof (React as { useId?: () => string }).useId === "function"
    ? (React as unknown as { useId: () => string }).useId
    : () => "";

/**
 * `useState` with a label. The only reliable way to attribute a render to a
 * specific piece of local state without React internals.
 *
 * **Call this inside a component that is itself instrumented** (wrapped with
 * `withRenderDetective`, or using `useRenderDiagnostics`). A hook cannot see
 * which component called it, only the nearest instrumented ancestor — so state
 * named in an uninstrumented descendant would be reported as the ancestor's.
 * The first caller under a given node claims it and later callers are ignored,
 * which stops a descendant from stealing the attribution, but it cannot rescue
 * the case where the ancestor never tracks state of its own.
 */
export function useTrackedState<S>(name: string, initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>] {
  const detective = getDetective();
  const node = useContext(AncestryContext);
  const ownerId = useOwnerId();
  const [state, setState] = useState<S>(initial);
  const previous = useRef<S>(state);

  if (node && node.stateOwner === undefined) node.stateOwner = ownerId;
  const owns = !node || node.stateOwner === ownerId;

  if (node && owns && !Object.is(previous.current, state)) {
    detective.recordStateChange(node, {
      name,
      previous: inspect(previous.current, detective.config.inspection),
      current: inspect(state, detective.config.inspection),
    });
    previous.current = state;
  } else if (!owns) {
    previous.current = state;
  }

  return [state, setState];
}

/**
 * `useEffect` that reports which of **its own declared** dependencies changed.
 *
 * This does not analyse whether the dependency list is correct — that needs
 * static analysis, not runtime observation (see docs/FEASIBILITY.md §9).
 */
export function useTrackedEffect(
  name: string,
  effect: () => void | (() => void),
  deps: unknown[],
): void {
  const detective = getDetective();
  const previous = useRef<unknown[] | undefined>(undefined);
  const changed = useRef<number[]>([]);

  if (detective.enabled) {
    const prev = previous.current;
    changed.current = prev
      ? deps.map((d, i) => (Object.is(d, prev[i]) ? -1 : i)).filter((i) => i >= 0)
      : [];
    previous.current = deps;
  }

  useEffect(() => {
    if (detective.enabled && detective.config.mode !== "silent" && changed.current.length > 0) {
      // eslint-disable-next-line no-console
      console.debug(`[RRD] effect ${name} ran — deps changed at index ${changed.current.join(", ")}`);
    }
    return effect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Reports when a context value changes, from inside the provider.
 * Returns the value untouched.
 */
export function useTrackedContextValue<T>(contextName: string, value: T): T {
  const detective = getDetective();
  const previous = useRef<T | undefined>(undefined);
  const first = useRef(true);

  if (detective.enabled) {
    if (first.current) {
      first.current = false;
    } else if (!Object.is(previous.current, value)) {
      const prev = previous.current;
      const equal = shallowEqual(prev, value, detective.config);
      const changedKeys =
        isRecord(prev) && isRecord(value)
          ? diffProps(prev, value, detective.config).changed.map((c) => c.key)
          : [];
      detective.recordContextChange({
        contextName,
        changedKeys,
        referenceOnly: equal === true,
        commitTime: -1,
      });
    }
    previous.current = value;
  }

  return value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
