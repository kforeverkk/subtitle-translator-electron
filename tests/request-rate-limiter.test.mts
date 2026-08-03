import assert from "node:assert/strict";
import test from "node:test";
import { RequestRateLimiter } from "../electron/main/utils/request-rate-limiter.ts";

function createControlledRuntime() {
  let now = 1;
  const waits: number[] = [];
  return {
    waits,
    setNow(value: number) {
      now = value;
    },
    runtime: {
      now: () => now,
      wait: (delayMs: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          waits.push(delayMs);
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    },
  };
}

async function waitForQueueTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("replaces a limiter policy without mutating returned policy snapshots", () => {
  const limiter = new RequestRateLimiter({
    requestsPerMinute: 60,
    minimumIntervalMs: 100,
  });
  assert.equal(typeof limiter.updatePolicy, "function");

  const previousPolicy = limiter.getPolicy();
  limiter.updatePolicy({
    requestsPerMinute: 30,
    minimumIntervalMs: 500,
  });

  assert.deepEqual(previousPolicy, {
    requestsPerMinute: 60,
    minimumIntervalMs: 100,
  });
  assert.deepEqual(limiter.getPolicy(), {
    requestsPerMinute: 30,
    minimumIntervalMs: 500,
  });
  assert.throws(
    () =>
      limiter.updatePolicy({
        requestsPerMinute: 0,
        minimumIntervalMs: 0,
      }),
    /positive integer/
  );
});

test("relaxing a policy wakes the queue without clearing request history", async () => {
  const clock = createControlledRuntime();
  const limiter = new RequestRateLimiter(
    { requestsPerMinute: 1, minimumIntervalMs: 0 },
    clock.runtime
  );
  assert.equal(typeof limiter.updatePolicy, "function");

  await limiter.waitForSlot();
  const waiting = limiter.waitForSlot();
  await waitForQueueTurn();
  assert.equal(clock.waits[0], 60_000);

  limiter.updatePolicy({ requestsPerMinute: 2, minimumIntervalMs: 0 });
  await waiting;

  assert.deepEqual(limiter.getPolicy(), {
    requestsPerMinute: 2,
    minimumIntervalMs: 0,
  });

  const controller = new AbortController();
  const thirdRequest = limiter.waitForSlot(controller.signal);
  await waitForQueueTurn();
  assert.equal(clock.waits[1], 60_000);
  controller.abort();
  await assert.rejects(thirdRequest, { name: "AbortError" });
});

test("a stricter interval is recalculated by the sleeping queue head", async () => {
  const clock = createControlledRuntime();
  const limiter = new RequestRateLimiter(
    { requestsPerMinute: 100, minimumIntervalMs: 100 },
    clock.runtime
  );
  assert.equal(typeof limiter.updatePolicy, "function");

  await limiter.waitForSlot();
  clock.setNow(51);
  const controller = new AbortController();
  const waiting = limiter.waitForSlot(controller.signal);
  await waitForQueueTurn();
  assert.equal(clock.waits[0], 50);

  limiter.updatePolicy({ requestsPerMinute: 100, minimumIntervalMs: 500 });
  await waitForQueueTurn();
  assert.equal(clock.waits[1], 450);

  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("cancels a request waiting behind another limiter turn", async () => {
  const limiter = new RequestRateLimiter({
    requestsPerMinute: 60,
    minimumIntervalMs: 10_000,
  });
  const firstRequest = limiter.waitForSlot();
  const controller = new AbortController();
  const secondRequest = limiter.waitForSlot(controller.signal);

  controller.abort();

  await assert.rejects(secondRequest, (error: unknown) => {
    return error instanceof Error && error.name === "AbortError";
  });
  await firstRequest;
});
