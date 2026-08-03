import { setTimeout as sleep } from "node:timers/promises";

const REQUEST_WINDOW_MS = 60_000;

export interface RequestRateLimitPolicy {
  requestsPerMinute: number;
  minimumIntervalMs: number;
}

interface RequestRateLimiterOptions {
  requestsPerMinute: number;
  minimumIntervalMs?: number;
}

export interface RequestRateLimiterRuntime {
  now: () => number;
  wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

const defaultRuntime: RequestRateLimiterRuntime = {
  now: () => Date.now(),
  wait: (delayMs, signal) => sleep(delayMs, undefined, { signal }),
};

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw getAbortReason(signal);
}

function waitForAbortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(getAbortReason(signal));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function validatePolicy(policy: RequestRateLimitPolicy): void {
  if (
    !Number.isSafeInteger(policy.requestsPerMinute) ||
    policy.requestsPerMinute < 1
  ) {
    throw new Error("Requests per minute must be a positive integer");
  }
  if (
    !Number.isFinite(policy.minimumIntervalMs) ||
    policy.minimumIntervalMs < 0
  ) {
    throw new Error("Minimum request interval must be a non-negative number");
  }
}

/** Serializes request starts while enforcing a rolling one-minute limit. */
export class RequestRateLimiter {
  private policy: RequestRateLimitPolicy;
  private readonly runtime: RequestRateLimiterRuntime;
  private policyChange!: Promise<void>;
  private resolvePolicyChange!: () => void;
  private requestTimes: number[] = [];
  private lastRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    {
      requestsPerMinute,
      minimumIntervalMs = 0,
    }: RequestRateLimiterOptions,
    runtime: RequestRateLimiterRuntime = defaultRuntime
  ) {
    this.runtime = runtime;
    this.policy = { requestsPerMinute, minimumIntervalMs };
    validatePolicy(this.policy);
    this.resetPolicyChangeNotification();
  }

  updatePolicy(policy: RequestRateLimitPolicy): void {
    validatePolicy(policy);
    if (
      policy.requestsPerMinute === this.policy.requestsPerMinute &&
      policy.minimumIntervalMs === this.policy.minimumIntervalMs
    ) {
      return;
    }

    this.policy = { ...policy };
    this.resolvePolicyChange();
    this.resetPolicyChangeNotification();
  }

  getPolicy(): Readonly<RequestRateLimitPolicy> {
    return { ...this.policy };
  }

  async waitForSlot(signal?: AbortSignal): Promise<void> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue;
    this.queue = previous.then(() => turn);

    try {
      await waitForAbortable(previous, signal);
      while (true) {
        throwIfAborted(signal);
        const now = this.runtime.now();
        this.requestTimes = this.requestTimes.filter(
          (requestTime) => now - requestTime < REQUEST_WINDOW_MS
        );

        const oldestRequestAt = this.requestTimes[0];
        const windowWaitMs =
          this.requestTimes.length >= this.policy.requestsPerMinute &&
          oldestRequestAt !== undefined
            ? oldestRequestAt + REQUEST_WINDOW_MS - now
            : 0;
        const intervalWaitMs =
          this.lastRequestAt > 0
            ? this.lastRequestAt + this.policy.minimumIntervalMs - now
            : 0;
        const waitMs = Math.max(windowWaitMs, intervalWaitMs);

        if (waitMs <= 0) {
          const requestStartedAt = this.runtime.now();
          this.requestTimes.push(requestStartedAt);
          this.lastRequestAt = requestStartedAt;
          return;
        }

        await this.waitForDelayOrPolicyChange(waitMs, signal);
      }
    } finally {
      release();
    }
  }

  private resetPolicyChangeNotification(): void {
    this.policyChange = new Promise<void>((resolve) => {
      this.resolvePolicyChange = resolve;
    });
  }

  private async waitForDelayOrPolicyChange(
    delayMs: number,
    taskSignal?: AbortSignal
  ): Promise<void> {
    const delayController = new AbortController();
    const delaySignal = taskSignal
      ? AbortSignal.any([taskSignal, delayController.signal])
      : delayController.signal;
    const observedPolicyChange = this.policyChange;
    try {
      await Promise.race([
        this.runtime.wait(delayMs, delaySignal),
        observedPolicyChange,
      ]);
    } finally {
      delayController.abort();
    }
    throwIfAborted(taskSignal);
  }
}
