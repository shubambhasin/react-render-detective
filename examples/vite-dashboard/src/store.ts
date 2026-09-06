import { configureStore, createSlice } from "@reduxjs/toolkit";
import { PRODUCTS } from "./data";

/**
 * A deliberately ordinary Redux store, so the detective is tested against real
 * react-redux rather than a model of it.
 *
 * `tick` exists to imitate the traffic every real app has — a poll, a timer, a
 * websocket — that updates a slice a component does not read. That is what makes
 * an unstable selector expensive: the component wakes for all of it.
 */
const catalogue = createSlice({
  name: "catalogue",
  initialState: { products: PRODUCTS, category: "All", tick: 0 },
  reducers: {
    setCategory(state, action: { payload: string }) {
      state.category = action.payload;
    },
    /** Changes nothing any component below reads. */
    heartbeat(state) {
      state.tick += 1;
    },
  },
});

export const { setCategory, heartbeat } = catalogue.actions;

export const store = configureStore({ reducer: { catalogue: catalogue.reducer } });
export type RootState = ReturnType<typeof store.getState>;
