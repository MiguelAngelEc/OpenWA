/**
 * A counting semaphore with a bounded waiting queue.
 *
 * Written rather than pulled from a dependency because the interesting part is
 * what it refuses to do: an unbounded queue would turn a burst of large
 * attachments into unbounded memory, which is the exact failure the caller is
 * trying to prevent. Waiters are therefore capped and time-limited, and a
 * rejected turn is a normal, expected outcome the caller reports - not an error
 * to retry.
 */

/** Rejected immediately because the waiting queue was already at its maximum. */
export class QueueFullError extends Error {
  constructor(queueMax: number) {
    super(`Semaphore queue is full (max ${queueMax} waiting)`);
    this.name = 'QueueFullError';
  }
}

/** Rejected because no turn became available within the configured timeout. */
export class QueueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for a semaphore slot`);
    this.name = 'QueueTimeoutError';
  }
}

/** Rejected because the semaphore was destroyed while the caller was waiting. */
export class SemaphoreDestroyedError extends Error {
  constructor() {
    super('Semaphore was destroyed');
    this.name = 'SemaphoreDestroyedError';
  }
}

export interface SemaphoreOptions {
  /** Turns granted at once. Must be >= 1. */
  concurrency: number;
  /** Callers allowed to wait. 0 rejects anything that cannot run immediately. */
  queueMax: number;
  /** How long a caller may wait before giving up. Must be > 0. */
  timeoutMs: number;
}

export interface SemaphoreStats {
  active: number;
  waiting: number;
  concurrency: number;
  queueMax: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class Semaphore {
  private active = 0;
  private destroyed = false;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly options: SemaphoreOptions) {
    if (options.concurrency < 1) {
      throw new Error(`Semaphore concurrency must be >= 1, received ${options.concurrency}`);
    }
    if (options.queueMax < 0) {
      throw new Error(`Semaphore queueMax must be >= 0, received ${options.queueMax}`);
    }
    if (options.timeoutMs <= 0) {
      throw new Error(`Semaphore timeoutMs must be > 0, received ${options.timeoutMs}`);
    }
  }

  get stats(): SemaphoreStats {
    return {
      active: this.active,
      waiting: this.waiters.length,
      concurrency: this.options.concurrency,
      queueMax: this.options.queueMax,
    };
  }

  /**
   * Waits for a turn and resolves with the function that gives it back.
   *
   * The release function is idempotent, so a caller that releases in a `finally`
   * and again on an error path cannot hand out the same slot twice.
   *
   * @throws QueueFullError when the queue is at capacity.
   * @throws QueueTimeoutError when no turn arrived in time.
   * @throws SemaphoreDestroyedError when the semaphore is or becomes destroyed.
   */
  acquire(): Promise<() => void> {
    if (this.destroyed) {
      return Promise.reject(new SemaphoreDestroyedError());
    }

    if (this.active < this.options.concurrency) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    if (this.waiters.length >= this.options.queueMax) {
      return Promise.reject(new QueueFullError(this.options.queueMax));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new QueueTimeoutError(this.options.timeoutMs));
        }, this.options.timeoutMs),
      };

      // Node keeps the process alive for a pending timer; a queued download is
      // not a reason to block a shutdown.
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /**
   * Rejects everything still waiting and refuses new callers.
   *
   * Turns already handed out are not revoked - the work is in flight and its
   * `finally` still runs - but releasing them will not start anything new.
   */
  destroy(): void {
    this.destroyed = true;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      waiter.reject(new SemaphoreDestroyedError());
    }
  }

  private createRelease(): () => void {
    let released = false;

    return () => {
      if (released) return;
      released = true;

      // Hand the slot straight to the next waiter instead of decrementing and
      // letting it re-check; that gap is what lets a late arrival overtake the
      // queue and push concurrency past its limit.
      const waiter = this.waiters.shift();
      if (waiter && !this.destroyed) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.createRelease());
        return;
      }

      this.active -= 1;
    };
  }
}
