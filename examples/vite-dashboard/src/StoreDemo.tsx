import { useSelector } from "react-redux";
import { useDispatch } from "react-redux";
import { heartbeat } from "./store";
import type { RootState } from "./store";

/**
 * PROBLEM 7 — a selector that builds a new array on every call.
 *
 * `useSelector` compares with Object.is, so this re-renders on *every* store
 * update — including the heartbeat, which changes nothing it reads.
 */
export function UnstableSelectorPanel() {
  const inStock = useSelector((state: RootState) => state.catalogue.products.filter((p) => p.stock > 0));
  return (
    <div className="badge">
      <strong>Unstable selector:</strong> {inStock.length} in stock
    </div>
  );
}

/** The same data, selected stably — this one should stay quiet. */
export function StableSelectorPanel() {
  const category = useSelector((state: RootState) => state.catalogue.category);
  const total = useSelector((state: RootState) => state.catalogue.products.length);
  return (
    <div className="badge">
      <strong>Stable selector:</strong> {total} products, filter {category}
    </div>
  );
}

export function HeartbeatButton() {
  const dispatch = useDispatch();
  return (
    <button onClick={() => dispatch(heartbeat())}>
      Store heartbeat (changes nothing these panels read)
    </button>
  );
}
