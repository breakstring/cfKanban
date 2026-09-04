export class WriteFence {
  readonly #active = new Set<string>();

  get active(): boolean {
    return this.#active.size > 0;
  }

  enter(key: string): boolean {
    if (this.#active.has(key)) return false;
    this.#active.add(key);
    return true;
  }

  leave(key: string): void {
    this.#active.delete(key);
  }

  has(key: string): boolean {
    return this.#active.has(key);
  }
}
