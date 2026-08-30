export class ProjectionGeneration {
  #value = 0;

  capture(): number {
    return this.#value;
  }

  invalidate(): number {
    this.#value += 1;
    return this.#value;
  }

  isCurrent(value: number): boolean {
    return value === this.#value;
  }
}
