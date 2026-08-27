import { afterEach, beforeEach } from "vitest";
import { reset } from "../src/index.js";

beforeEach(() => {
  reset();
});

afterEach(() => {
  reset();
});
