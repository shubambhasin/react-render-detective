import { Profiler, useCallback, useContext, useLayoutEffect, useState } from "react";
import type { ProfilerOnRenderCallback, ReactNode } from "react";
import { getDetective } from "../core/store.js";
import type { NodeRecord } from "../core/store.js";
import type { RenderPhase } from "../core/types.js";
import { AncestryContext } from "./ancestry.js";

export interface TrackOptions {
  /** Overrides the inferred component name. Required for anonymous components. */
  name?: string;
}

/**
 * Registers the current component, records this render attempt, and returns the
 * node plus a Profiler callback. All of it is a no-op when disabled.
 */
export function useInstrumentedNode(
  name: string,
  props: Record<string, unknown>,
): { node: NodeRecord | undefined; onRender: ProfilerOnRenderCallback } {
  const detective = getDetective();
  const parent = useContext(AncestryContext);

  // The active/inactive decision is frozen per instance so the element tree
  // shape never changes underneath a mounted component.
  const [node] = useState<NodeRecord | undefined>(() =>
    detective.enabled ? detective.createNode(name, parent) : undefined,
  );

  useLayoutEffect(() => {
    if (!node) return;
    detective.attach(node);
    return () => detective.detach(node);
  }, [detective, node]);

  if (node) {
    try {
      detective.recordAttempt(node, props);
    } catch {
      /* never break the app being debugged (§46) */
    }
  }

  const onRender = useCallback<ProfilerOnRenderCallback>(
    (_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      if (!node) return;
      try {
        detective.recordCommit(node, {
          phase: phase as RenderPhase,
          subtreeDuration: actualDuration,
          baseDuration,
          startTime,
          commitTime,
        });
      } catch {
        /* ignore */
      }
    },
    [detective, node],
  );

  return { node, onRender };
}

export function renderInstrumented(
  node: NodeRecord | undefined,
  onRender: ProfilerOnRenderCallback,
  children: ReactNode,
): ReactNode {
  if (!node) return children;
  return (
    <Profiler id={node.id} onRender={onRender}>
      <AncestryContext.Provider value={node}>{children}</AncestryContext.Provider>
    </Profiler>
  );
}

export function componentName(component: unknown, fallback = "Anonymous"): string {
  const c = component as { displayName?: string; name?: string; type?: unknown } | null;
  if (!c) return fallback;
  if (typeof c.displayName === "string" && c.displayName) return c.displayName;
  if (typeof c.name === "string" && c.name) return c.name;
  // React.memo / forwardRef wrappers keep the real component on `.type`.
  if (c.type) return componentName(c.type, fallback);
  return fallback;
}
