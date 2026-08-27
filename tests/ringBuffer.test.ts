import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/core/ringBuffer.js";

describe("RingBuffer", () => {
  it("keeps only the newest items, oldest first", () => {
    const b = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) b.push(i);
    expect(b.toArray()).toEqual([3, 4, 5]);
    expect(b.size).toBe(3);
  });

  it("stays bounded under 100k pushes", () => {
    const b = new RingBuffer<number>(1000);
    for (let i = 0; i < 100_000; i++) b.push(i);
    expect(b.size).toBe(1000);
    expect(b.toArray()[999]).toBe(99_999);
  });

  it("preserves the newest items when shrinking", () => {
    const b = new RingBuffer<number>(5);
    for (let i = 1; i <= 5; i++) b.push(i);
    b.resize(2);
    expect(b.toArray()).toEqual([4, 5]);
  });

  it("clears", () => {
    const b = new RingBuffer<number>(2);
    b.push(1);
    b.clear();
    expect(b.toArray()).toEqual([]);
  });
});
