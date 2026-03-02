import { AsyncSemaphore } from '../predictionQueue';

describe('AsyncSemaphore', () => {
  it('allows up to max concurrent acquisitions', async () => {
    const maxConcurrency = 3;
    const semaphore = new AsyncSemaphore(maxConcurrency);
    let runningCount = 0;
    let promises: Promise<void>[] = [];

    // Acquire up to maxConcurrency
    for (let i = 0; i < maxConcurrency; i++) {
      promises.push(semaphore.acquire().then(() => {
        runningCount++;
      }));
    }
    await Promise.all(promises);
    expect(runningCount).toBe(maxConcurrency);
  });

  it('blocks additional acquisitions until a slot is released', async () => {
    const maxConcurrency = 3;
    const semaphore = new AsyncSemaphore(maxConcurrency);
    let runningCount = 0;
    const acquisitionOrder: number[] = [];
    let promises: Promise<void>[] = []; // Correct declaration here

    // Acquire maxConcurrency slots
    const releaseFunctions: (() => void)[] = [];
    for (let i = 0; i < maxConcurrency; i++) {
      const p = new Promise<void>(resolve => {
        semaphore.acquire().then(() => {
          runningCount++;
          acquisitionOrder.push(i);
          resolve();
        });
      });
      promises.push(p);

      // Create a function to release this specific acquisition
      releaseFunctions.push(() => {
        semaphore.release();
        runningCount--; // Decrement runningCount when a slot is released
      });
    }

    // Attempt a 4th acquisition immediately
    let fourthAcquired = false;
    const fourthPromise = semaphore.acquire().then(() => {
      runningCount++;
      acquisitionOrder.push(3);
      fourthAcquired = true;
    });
    promises.push(fourthPromise);

    // At this point, the first 3 should be acquired, the 4th should be blocked
    await Promise.resolve(); // Allow promises to settle
    expect(runningCount).toBe(maxConcurrency);
    expect(fourthAcquired).toBe(false); // Fourth should not have acquired yet

    // Release one slot
    releaseFunctions[0]();
    await Promise.resolve(); // Allow promises to settle
    expect(runningCount).toBe(maxConcurrency); // Should still be max as 4th takes the slot
    expect(fourthAcquired).toBe(true); // Fourth should now be acquired
    expect(acquisitionOrder).toEqual([0, 1, 2, 3]); // Verify order

    // Release remaining slots
    releaseFunctions[1]();
    releaseFunctions[2]();
    semaphore.release(); // Release the slot taken by the 4th acquisition

    await Promise.all(promises); // Wait for all promises to complete
  });

  it('isFull returns true when running count equals max', () => {
    const semaphore = new AsyncSemaphore(1);
    expect(semaphore.isFull()).toBe(false);
    
    // Acquire the single slot
    semaphore.acquire();
    expect(semaphore.isFull()).toBe(true); // Should be full
    
    // Release the slot
    semaphore.release();
    expect(semaphore.isFull()).toBe(false);
  });

  it('isFull returns true when running count exceeds max (should not happen in normal operation but good for robustness)', async () => {
    const semaphore = new AsyncSemaphore(1);
    
    // Manually increment running beyond max (simulating a bug or test scenario)
    await semaphore.acquire(); // running = 1
    (semaphore as any)['running'] = 2; // Force running to be 2
    
    expect(semaphore.isFull()).toBe(true);
  });

  it('does not allow new acquisitions when full', async () => {
    const semaphore = new AsyncSemaphore(1);
    let firstAcquired = false;
    let secondAcquired = false;

    // Acquire the single slot
    const p1 = semaphore.acquire().then(() => {
      firstAcquired = true;
    });

    // Attempt a second acquisition immediately
    const p2 = semaphore.acquire().then(() => {
      secondAcquired = true;
    });

    await Promise.resolve(); // Allow promises to settle
    expect(firstAcquired).toBe(true);
    expect(secondAcquired).toBe(false); // Second should be blocked

    semaphore.release(); // Release the first slot
    await Promise.resolve(); // Allow promises to settle
    expect(secondAcquired).toBe(true); // Second should now be acquired
  });
});