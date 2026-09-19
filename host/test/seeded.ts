export class SeededRandom {
  private state: number;
  constructor(readonly seed: number) { this.state = seed >>> 0 || 0x6d2b79f5; }
  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
  integer(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    return Math.floor(this.next() * limit);
  }
  boolean(probability = 0.5): boolean { return this.next() < probability; }
  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new RangeError("cannot pick from an empty list");
    return values[this.integer(values.length)]!;
  }
}

export function seedLabel(seed: number): string { return `0x${(seed >>> 0).toString(16).padStart(8, "0")}`; }
