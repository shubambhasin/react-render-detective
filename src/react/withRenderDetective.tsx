import type { ComponentType } from "react";

/** Marks a component as one of ours, so it is never wrapped twice. */
const IS_WRAPPER = Symbol.for("react-render-detective.wrapper");
import { componentName, renderInstrumented, useInstrumentedNode } from "./instrument.js";
import type { TrackOptions } from "./instrument.js";

/**
 * Wraps a component with full instrumentation: render counting, prop diffing,
 * parent attribution and Profiler timings.
 *
 * This is the most accurate integration mode — the wrapper's render function
 * runs exactly when the wrapped component re-renders, and it receives the same
 * props, so every diagnosis has first-hand evidence.
 *
 * Ref note: on React 19 `ref` is an ordinary prop and passes through the spread.
 * On React 18 and below, wrap with `forwardRef` yourself if the component needs
 * a ref.
 */
export function withRenderDetective<P extends object>(
  Component: ComponentType<P>,
  options: TrackOptions = {},
): ComponentType<P> {
  /*
   * Wrapping a wrapper would make it render itself. That is unreachable through
   * careful hand-wrapping but trivially reachable once a build plugin is
   * wrapping everything, and the failure mode is a stack overflow before first
   * paint — so return the existing wrapper instead.
   */
  if ((Component as { [IS_WRAPPER]?: boolean })[IS_WRAPPER]) return Component;

  const name = options.name ?? componentName(Component);

  function RenderDetected(props: P) {
    const { node, onRender } = useInstrumentedNode(name, props as Record<string, unknown>, options.source);
    return renderInstrumented(node, onRender, <Component {...props} />);
  }

  RenderDetected.displayName = `RenderDetective(${name})`;
  (RenderDetected as { [IS_WRAPPER]?: boolean })[IS_WRAPPER] = true;
  return RenderDetected;
}
