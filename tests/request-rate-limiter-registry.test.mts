import assert from "node:assert/strict";
import test from "node:test";
import { RequestRateLimiterRegistry } from "../electron/main/utils/request-rate-limiter-registry.ts";

test("same API account shares one limiter with the strictest active policy", () => {
  const registry = new RequestRateLimiterRegistry();
  const first = registry.acquire({
    apiHost: "https://api.example.com/v1",
    apiKey: "key-one",
    requestsPerMinute: 60,
    minimumIntervalMs: 100,
  });
  const second = registry.acquire({
    apiHost: "https://API.example.com:443/v1/",
    apiKey: "key-one",
    requestsPerMinute: 30,
    minimumIntervalMs: 500,
  });

  assert.equal(first.limiter, second.limiter);
  assert.deepEqual(first.limiter.getPolicy(), {
    requestsPerMinute: 30,
    minimumIntervalMs: 500,
  });

  second.release();
  assert.deepEqual(first.limiter.getPolicy(), {
    requestsPerMinute: 60,
    minimumIntervalMs: 100,
  });

  first.release();
  first.release();
  const replacement = registry.acquire({
    apiHost: "https://api.example.com/v1",
    apiKey: "key-one",
    requestsPerMinute: 60,
    minimumIntervalMs: 100,
  });
  assert.notEqual(replacement.limiter, first.limiter);
  replacement.release();
});

test("different API keys and hosts use independent limiters", () => {
  const registry = new RequestRateLimiterRegistry();
  const base = registry.acquire({
    apiHost: "https://api.example.com/v1",
    apiKey: "key-one",
    requestsPerMinute: 60,
    minimumIntervalMs: 0,
  });
  const keyTwo = registry.acquire({
    apiHost: "https://api.example.com/v1",
    apiKey: "key-two",
    requestsPerMinute: 60,
    minimumIntervalMs: 0,
  });
  const hostTwo = registry.acquire({
    apiHost: "https://other.example.com/v1",
    apiKey: "key-one",
    requestsPerMinute: 60,
    minimumIntervalMs: 0,
  });

  assert.notEqual(base.limiter, keyTwo.limiter);
  assert.notEqual(base.limiter, hostTwo.limiter);
  assert.notEqual(keyTwo.limiter, hostTwo.limiter);

  base.release();
  keyTwo.release();
  hostTwo.release();
});

test("a rejected lease does not poison later work for the account", () => {
  const registry = new RequestRateLimiterRegistry();
  const first = registry.acquire({
    apiHost: "https://api.example.com/v1",
    apiKey: "key-one",
    requestsPerMinute: 60,
    minimumIntervalMs: 0,
  });

  assert.throws(
    () =>
      registry.acquire({
        apiHost: "https://api.example.com/v1",
        apiKey: "key-one",
        requestsPerMinute: 0,
        minimumIntervalMs: 0,
      }),
    /positive integer/
  );

  const second = registry.acquire({
    apiHost: "https://api.example.com/v1",
    apiKey: "key-one",
    requestsPerMinute: 30,
    minimumIntervalMs: 0,
  });
  assert.equal(second.limiter, first.limiter);
  assert.deepEqual(second.limiter.getPolicy(), {
    requestsPerMinute: 30,
    minimumIntervalMs: 0,
  });

  second.release();
  first.release();
});
