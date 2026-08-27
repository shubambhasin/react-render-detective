import { createContext } from "react";
import type { NodeRecord } from "../core/store.js";

/**
 * Carries the nearest instrumented ancestor down the tree.
 *
 * The value is the node object, created once per mounted instance and **never
 * replaced**. That is deliberate: a context value that changed per render would
 * force every instrumented descendant to re-render, defeating `React.memo` and
 * changing the behaviour of the very app we are measuring.
 */
export const AncestryContext = createContext<NodeRecord | undefined>(undefined);
AncestryContext.displayName = "RenderDetectiveAncestry";
