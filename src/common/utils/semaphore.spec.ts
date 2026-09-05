import { Semaphore, QueueFullError, QueueTimeoutError, SemaphoreDestroyedError } from './semaphore';

describe('Semaphore', () => {
  const build = (overrides: Partial<{ concurrency: number; queueMax: number; timeoutMs: number }> = {}) =>
    new Semaphore({ concurrency: 1, queueMax: 10, timeoutMs: 1000, ...overrides });

  describe('construction', () => {
    it.each([
      ['concurrency below 1', { concurrency: 0 }],
      ['a negative queue', { queueMax: -1 }],
      ['a non-positive timeout', { timeoutMs: 0 }],
    ])('rejects %s', (_label, overrides) => {
      expect(() => build(overrides)).toThrow();
    });
  });

  describe('acquire', () => {
    it('grants turns immediately up to the concurrency limit', async () => {
      const semaphore = build({ concurrency: 2 });

      await semaphore.acquire();
      await semaphore.acquire();

      expect(semaphore.stats).toMatchObject({ active: 2, waiting: 0 });
    });

    it('queues callers beyond the limit and hands the slot on release', async () => {
      const semaphore = build({ concurrency: 1 });
      const release = await semaphore.acquire();

      let granted = false;
      const queued = semaphore.acquire().then(() => {
        granted = true;
      });

      await Promise.resolve();
      expect(granted).toBe(false);
      expect(semaphore.stats).toMatchObject({ active: 1, waiting: 1 });

      release();
      await queued;

      expect(granted).toBe(true);
      // The slot moved rather than being freed and re-taken.
      expect(semaphore.stats).toMatchObject({ active: 1, waiting: 0 });
    });

    it('rejects with QueueFullError once the queue is at capacity', async () => {
      const semaphore = build({ concurrency: 1, queueMax: 1 });

      await semaphore.acquire();
      const queued = semaphore.acquire();

      await expect(semaphore.acquire()).rejects.toBeInstanceOf(QueueFullError);

      // Settle the parked waiter so its timer does not outlive the test.
      semaphore.destroy();
      await expect(queued).rejects.toBeInstanceOf(SemaphoreDestroyedError);
    });

    it('rejects immediately when queueMax is 0', async () => {
      const semaphore = build({ concurrency: 1, queueMax: 0 });
      await semaphore.acquire();

      await expect(semaphore.acquire()).rejects.toBeInstanceOf(QueueFullError);
    });

    it('rejects with QueueTimeoutError and stops occupying the queue', async () => {
      jest.useFakeTimers();
      try {
        const semaphore = build({ concurrency: 1, timeoutMs: 500 });
        await semaphore.acquire();

        const queued = semaphore.acquire();
        jest.advanceTimersByTime(501);

        await expect(queued).rejects.toBeInstanceOf(QueueTimeoutError);
        expect(semaphore.stats).toMatchObject({ active: 1, waiting: 0 });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('release', () => {
    it('is idempotent, so a double release cannot hand out a slot twice', async () => {
      const semaphore = build({ concurrency: 1 });
      const release = await semaphore.acquire();

      release();
      release();

      expect(semaphore.stats).toMatchObject({ active: 0, waiting: 0 });
    });

    it('frees the slot when nobody is waiting', async () => {
      const semaphore = build({ concurrency: 2 });
      const first = await semaphore.acquire();
      await semaphore.acquire();

      first();

      expect(semaphore.stats).toMatchObject({ active: 1 });
    });
  });

  describe('destroy', () => {
    it('rejects everything still waiting', async () => {
      const semaphore = build({ concurrency: 1 });
      await semaphore.acquire();
      const queued = semaphore.acquire();

      semaphore.destroy();

      await expect(queued).rejects.toBeInstanceOf(SemaphoreDestroyedError);
      expect(semaphore.stats).toMatchObject({ waiting: 0 });
    });

    it('refuses new callers afterwards', async () => {
      const semaphore = build();
      semaphore.destroy();

      await expect(semaphore.acquire()).rejects.toBeInstanceOf(SemaphoreDestroyedError);
    });

    it('lets an in-flight release complete without starting new work', async () => {
      const semaphore = build({ concurrency: 1 });
      const release = await semaphore.acquire();

      semaphore.destroy();
      expect(() => release()).not.toThrow();
      expect(semaphore.stats).toMatchObject({ active: 0, waiting: 0 });
    });
  });

  it('keeps instances independent, so one session cannot starve another', async () => {
    const first = build({ concurrency: 1, queueMax: 0 });
    const second = build({ concurrency: 1, queueMax: 0 });

    await first.acquire();

    await expect(second.acquire()).resolves.toBeInstanceOf(Function);
  });
});
