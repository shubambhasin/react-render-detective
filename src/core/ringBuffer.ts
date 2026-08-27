/** Fixed-capacity ring buffer. Bounded memory is a hard requirement (§26). */
export class RingBuffer<T> {
  private items: Array<T | undefined>;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.items = new Array<T | undefined>(Math.max(1, capacity));
  }

  push(item: T): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.items.length;
    if (this.count < this.items.length) this.count++;
  }

  get size(): number {
    return this.count;
  }

  /** Oldest → newest. */
  toArray(): T[] {
    const out: T[] = [];
    const len = this.items.length;
    const start = (this.head - this.count + len) % len;
    for (let i = 0; i < this.count; i++) {
      const v = this.items[(start + i) % len];
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  clear(): void {
    this.items = new Array<T | undefined>(this.items.length);
    this.head = 0;
    this.count = 0;
  }

  resize(capacity: number): void {
    const existing = this.toArray();
    this.items = new Array<T | undefined>(Math.max(1, capacity));
    this.head = 0;
    this.count = 0;
    const keep = existing.slice(Math.max(0, existing.length - this.items.length));
    for (const item of keep) this.push(item);
  }
}
