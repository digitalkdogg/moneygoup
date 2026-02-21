// src/utils/predictionQueue.ts
// Simple async semaphore — caps concurrent Python prediction processes.

export class AsyncSemaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next(); // Promote next waiter — running count stays the same
    } else {
      this.running--;
    }
  }

  isFull(): boolean {
    return this.running >= this.max && this.queue.length > 0;
  }
}

/** Max 3 Python prediction processes running simultaneously. */
export const predictionSemaphore = new AsyncSemaphore(3);
