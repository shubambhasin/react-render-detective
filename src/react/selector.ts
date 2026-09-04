/**
 * External-store attribution.
 *
 * Without this, a Redux or Zustand render can only ever be reported as
 * "state or an external store" — the tool proves the render started inside the
 * component but cannot say which value caused it. On a real application that
 * covered 84% of one component's renders, which is where the whole product
 * stopped being useful.
 *
 * `useSelector` is a public hook from a public package, so wrapping it needs no
 * internals: every value it returns is observable, including the one that
 * matters most — a selector that builds a new object on every call, which makes
 * the component re-render on *every* store update.
 */
import * as React from "react";
import { useContext, useRef } from "react";
import { shallowEqual } from "../core/compare.js";
import { inspect } from "../core/inspect.js";
import { getDetective } from "../core/store.js";
import { AncestryContext } from "./ancestry.js";

/** React 18+. Identifies the calling component so a descendant cannot steal attribution. */
const useOwnerId: () => string =
  typeof (React as { useId?: () => string }).useId === "function"
    ? (React as unknown as { useId: () => string }).useId
    : () => "";

export interface TrackSelectorOptions {
  /** Readable label — a property path where one could be derived, else the call site. */
  name?: string;
  /** `File.tsx:12:3` of the call, supplied by the build plugin. */
  source?: string;
}

/**
 * Records a store value and returns it untouched.
 *
 * Pass-through by construction: the value is returned as given, and nothing
 * here can change what the component receives.
 */
export function trackSelector<T>(value: T, options: TrackSelectorOptions = {}): T {
  const detective = getDetective();
  const node = useContext(AncestryContext);
  const ownerId = useOwnerId();
  const previous = useRef<{ value: T } | undefined>(undefined);

  if (!detective.enabled) return value;

  // Same ownership rule as useTrackedState: the first caller under a node claims
  // it, so a selector in an uninstrumented descendant cannot be reported as the
  // ancestor's. Several selectors in one component share its id, so they all pass.
  if (node && node.stateOwner === undefined) node.stateOwner = ownerId;
  const owns = !node || node.stateOwner === ownerId;

  const prior = previous.current;
  previous.current = { value };

  if (!prior || !node || !owns) return value;
  if (Object.is(prior.value, value)) return value;

  try {
    const equal = shallowEqual(prior.value, value, detective.config);
    detective.recordSelectorChange(node, {
      name: options.name ?? options.source ?? "selector",
      source: options.source,
      referenceOnly: equal === true,
      previous: inspect(prior.value, detective.config.inspection),
      current: inspect(value, detective.config.inspection),
    });
  } catch {
    /* diagnostics must never break the app */
  }

  return value;
}

/**
 * Wraps a store hook so its results are attributed. Signature-preserving: extra
 * arguments (react-redux's equality function, for instance) pass straight
 * through, because changing them would change the app's behaviour.
 *
 *   const useSelector = createTrackedSelectorHook(useReduxSelector);
 *
 * The build plugin rewrites `useSelector` imports for you; use this directly for
 * a custom store hook, or where the plugin cannot run.
 */
export function createTrackedSelectorHook<A extends unknown[], R>(
  hook: (...args: A) => R,
  options: TrackSelectorOptions = {},
): (...args: A) => R {
  return function useTrackedSelector(...args: A): R {
    // Hook order is fixed: the wrapped hook, then the recorder. Both always run.
    const value = hook(...args);
    return trackSelector(value, options);
  };
}
