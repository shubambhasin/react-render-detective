import type { ComponentType } from "react";
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
  const name = options.name ?? componentName(Component);

  function RenderDetected(props: P) {
    const { node, onRender } = useInstrumentedNode(name, props as Record<string, unknown>);
    return renderInstrumented(node, onRender, <Component {...props} />);
  }

  RenderDetected.displayName = `RenderDetective(${name})`;
  return RenderDetected;
}
