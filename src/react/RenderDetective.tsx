import type { ReactNode } from "react";
import { renderInstrumented, useInstrumentedNode } from "./instrument.js";

export interface RenderDetectiveProps {
  name: string;
  children: ReactNode;
}

/**
 * Zero-refactor integration: drop it around a subtree.
 *
 *   <RenderDetective name="UserProfile"><UserProfile /></RenderDetective>
 *
 * Accuracy note: this boundary only sees the `children` **element**, not the
 * wrapped component's props. It therefore reports timings, parent propagation
 * and children-element churn accurately, but it cannot attribute a render to an
 * individual prop. Use `withRenderDetective` when you want per-prop diagnosis.
 */
export function RenderDetective({ name, children }: RenderDetectiveProps): ReactNode {
  const { node, onRender } = useInstrumentedNode(name, { children });
  return renderInstrumented(node, onRender, children);
}
