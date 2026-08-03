# Account-scoped RPM Limiter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one strict, dynamically updated RPM and request-interval budget across all concurrent batches that use the same normalized API URL and API key.

**Architecture:** Extract API-account identity into a focused helper, make the existing FIFO rolling-window limiter dynamically updateable without losing history, and add a main-process lease registry that shares one limiter per API account. The `batch-translate` handler acquires one lease after validation and releases it in its outer `finally`; all request-producing operations keep using the existing limiter interface.

**Tech Stack:** TypeScript 7, Electron 43, Node.js 24 built-ins and test runner, Playwright Electron E2E.

## Global Constraints

- Group by normalized API base URL plus the first non-empty API key actually used by requests.
- Never log or expose raw API keys; registry identities contain an in-memory SHA-256 key digest.
- Enforce the lowest active RPM and longest active minimum interval per account.
- Preserve rolling request history whenever active limits change.
- Add no API requests, token use, checkpoint writes, or content-configuration fields.
- Do not slow a batch that runs alone.
- Keep different URLs or keys independent.
- Preserve FIFO ordering, per-file concurrency, retries, cancellation, checkpoint, and output behavior.

---

## File Map

- Create `electron/main/utils/api-account.ts` for active-key selection and account identity.
- Modify `electron/main/utils/translate.ts` to import the shared key selector.
- Modify `electron/main/utils/request-rate-limiter.ts` for dynamic policy updates.
- Create `electron/main/utils/request-rate-limiter-registry.ts` for account leases.
- Modify `electron/main/index.ts` to acquire and release one lease per batch IPC call.
- Add `tests/api-account.test.mts` and `tests/request-rate-limiter-registry.test.mts`.
- Expand `tests/request-rate-limiter.test.mts`.
- Modify `package.json` to include the new unit tests.
- Modify `e2e/example.spec.ts` to verify shared timing and unchanged API-call counts.

---

### Task 1: API account identity

**Files:**
- Create: `electron/main/utils/api-account.ts`
- Modify: `electron/main/utils/translate.ts:250-270`
- Create: `tests/api-account.test.mts`
- Modify: `package.json:20`

**Interfaces:**
- Produces: `getFirstValidApiKey(apiKeys: readonly string[]): string`
- Produces: `normalizeApiBaseUrl(apiHost: string): string`
- Produces: `createApiAccountIdentity(apiHost: string, apiKey: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createApiAccountIdentity,
  getFirstValidApiKey,
  normalizeApiBaseUrl,
} from "../electron/main/utils/api-account.ts";

test("selects the first non-empty key", () => {
  assert.equal(getFirstValidApiKey(["  ", " key-one ", "key-two"]), "key-one");
  assert.throws(() => getFirstValidApiKey(["", "  "]), /ERR_NO_VALID_API_KEYS/);
});

test("normalizes equivalent base URLs", () => {
  assert.equal(
    normalizeApiBaseUrl("HTTPS://API.Example.com:443/v1/"),
    "https://api.example.com/v1"
  );
});

test("account identity never contains the raw key", () => {
  const identity = createApiAccountIdentity(
    "https://api.example.com/v1/",
    "super-secret-key"
  );
  assert.equal(identity.includes("super-secret-key"), false);
  assert.match(identity, /^https:\/\/api\.example\.com\/v1\n[a-f\d]{64}$/);
  assert.equal(
    identity,
    createApiAccountIdentity("https://api.example.com/v1", "super-secret-key")
  );
});
```

- [ ] **Step 2: Add the new test file to `package.json` and verify red**

Run:

```powershell
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/api-account.test.mts
```

Expected: FAIL because `api-account.ts` does not exist.

- [ ] **Step 3: Implement the minimal helper**

```ts
import { createHash } from "node:crypto";
import { translationErrorCodes } from "../../shared/translation-error-codes";

export function getFirstValidApiKey(apiKeys: readonly string[]): string {
  const apiKey = apiKeys.map((key) => key.trim()).find(Boolean);
  if (!apiKey) throw new Error(translationErrorCodes.noValidApiKeys);
  return apiKey;
}

export function normalizeApiBaseUrl(apiHost: string): string {
  const url = new URL(apiHost.trim());
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const serialized = url.toString();
  return url.pathname === "/" && !url.search
    ? serialized.replace(/\/$/, "")
    : serialized;
}

export function createApiAccountIdentity(apiHost: string, apiKey: string) {
  const digest = createHash("sha256").update(apiKey).digest("hex");
  return `${normalizeApiBaseUrl(apiHost)}\n${digest}`;
}
```

Delete the private key selector from `translate.ts`, import this helper, and leave the three API call sites unchanged.

- [ ] **Step 4: Verify green and type safety**

```powershell
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/api-account.test.mts
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add electron/main/utils/api-account.ts electron/main/utils/translate.ts tests/api-account.test.mts package.json
git commit -m "refactor: centralize API account identity"
```

---

### Task 2: Dynamic FIFO rate policy

**Files:**
- Modify: `electron/main/utils/request-rate-limiter.ts`
- Modify: `tests/request-rate-limiter.test.mts`

**Interfaces:**
- Produces: `RequestRateLimitPolicy`
- Produces: `RequestRateLimiterRuntime`
- Produces: `updatePolicy(policy): void`
- Produces: `getPolicy(): Readonly<RequestRateLimitPolicy>`
- Preserves: `waitForSlot(signal?): Promise<void>`

- [ ] **Step 1: Write failing tests for policy replacement and wakeup**

Add a controllable runtime to the test:

```ts
function controlledRuntime() {
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

test("relaxing a policy wakes the queue without clearing history", async () => {
  const clock = controlledRuntime();
  const limiter = new RequestRateLimiter(
    { requestsPerMinute: 1, minimumIntervalMs: 0 },
    clock.runtime
  );
  await limiter.waitForSlot();
  const waiting = limiter.waitForSlot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.waits[0], 60_000);
  limiter.updatePolicy({ requestsPerMinute: 2, minimumIntervalMs: 0 });
  await waiting;
  assert.deepEqual(limiter.getPolicy(), {
    requestsPerMinute: 2,
    minimumIntervalMs: 0,
  });
});

test("a stricter interval is recalculated by the sleeping queue head", async () => {
  const clock = controlledRuntime();
  const limiter = new RequestRateLimiter(
    { requestsPerMinute: 100, minimumIntervalMs: 100 },
    clock.runtime
  );
  await limiter.waitForSlot();
  clock.setNow(51);
  const controller = new AbortController();
  const waiting = limiter.waitForSlot(controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.waits[0], 50);
  limiter.updatePolicy({ requestsPerMinute: 100, minimumIntervalMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.waits[1], 450);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});
```

- [ ] **Step 2: Run the focused test and verify red**

```powershell
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/request-rate-limiter.test.mts
```

Expected: FAIL because runtime injection and policy updates are absent.

- [ ] **Step 3: Implement mutable policy and policy-change notification**

```ts
export interface RequestRateLimitPolicy {
  requestsPerMinute: number;
  minimumIntervalMs: number;
}

export interface RequestRateLimiterRuntime {
  now: () => number;
  wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}
```

Store `policy` instead of readonly scalar fields. `updatePolicy` validates both values, returns early when unchanged, resolves the current policy-change promise, and creates the next one. `getPolicy` returns a copy.

Use this delay helper so stricter and looser updates both wake the queue head:

```ts
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
```

The default runtime calls `Date.now()` and `sleep(delayMs, undefined, { signal })`. Every loop iteration reads current policy values; do not clear `requestTimes` or `lastRequestAt` in `updatePolicy`.

- [ ] **Step 4: Run limiter tests and type checking**

```powershell
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/request-rate-limiter.test.mts
pnpm run typecheck
```

Expected: PASS, including the original cancellation test.

- [ ] **Step 5: Commit**

```powershell
git add electron/main/utils/request-rate-limiter.ts tests/request-rate-limiter.test.mts
git commit -m "feat: support dynamic request rate policies"
```

---

### Task 3: Account lease registry and IPC integration

**Files:**
- Create: `electron/main/utils/request-rate-limiter-registry.ts`
- Create: `tests/request-rate-limiter-registry.test.mts`
- Modify: `package.json:20`
- Modify: `electron/main/index.ts:44-45,1123-1611`

**Interfaces:**
- Consumes: `createApiAccountIdentity`
- Consumes: `RequestRateLimiter` and `RequestRateLimitPolicy`
- Produces: `RequestRateLimiterRegistry.acquire(options)` returning `{ limiter, release }`

- [ ] **Step 1: Write failing registry tests**

```ts
test("same account shares the strictest policy", () => {
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
  assert.equal(registry.getActiveAccountCount(), 0);
});

test("different key and host use independent limiters", () => {
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
  base.release();
  keyTwo.release();
  hostTwo.release();
});
```

- [ ] **Step 2: Add the test file to `package.json` and verify red**

```powershell
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/request-rate-limiter-registry.test.mts
```

Expected: FAIL because the registry module does not exist.

- [ ] **Step 3: Implement the registry**

```ts
interface RegistryEntry {
  limiter: RequestRateLimiter;
  leases: Map<string, RequestRateLimitPolicy>;
}

export class RequestRateLimiterRegistry {
  private readonly accounts = new Map<string, RegistryEntry>();

  acquire(options: AcquireOptions): RequestRateLimiterLease {
    const identity = createApiAccountIdentity(options.apiHost, options.apiKey);
    const policy = {
      requestsPerMinute: options.requestsPerMinute,
      minimumIntervalMs: options.minimumIntervalMs,
    };
    const entry = this.accounts.get(identity) ?? {
      limiter: new RequestRateLimiter(policy),
      leases: new Map<string, RequestRateLimitPolicy>(),
    };
    this.accounts.set(identity, entry);
    const leaseId = randomUUID();
    entry.leases.set(leaseId, policy);
    this.applyStrictestPolicy(entry);
    let released = false;
    return {
      limiter: entry.limiter,
      release: () => {
        if (released) return;
        released = true;
        entry.leases.delete(leaseId);
        if (entry.leases.size === 0) this.accounts.delete(identity);
        else this.applyStrictestPolicy(entry);
      },
    };
  }

  getActiveAccountCount(): number {
    return this.accounts.size;
  }

  private applyStrictestPolicy(entry: RegistryEntry): void {
    const policies = [...entry.leases.values()];
    entry.limiter.updatePolicy({
      requestsPerMinute: Math.min(...policies.map((p) => p.requestsPerMinute)),
      minimumIntervalMs: Math.max(...policies.map((p) => p.minimumIntervalMs)),
    });
  }
}
```

- [ ] **Step 4: Replace per-call limiter construction in `batch-translate`**

Create one main-process registry singleton. After request validation and duplicate task-ID rejection, acquire:

```ts
const requestRateLimiterLease = requestRateLimiterRegistry.acquire({
  apiHost: params.apiHost,
  apiKey: getFirstValidApiKey(params.apiKeys),
  requestsPerMinute: params.requestsPerMinute,
  minimumIntervalMs: params.delay,
});
const requestRateLimiter = requestRateLimiterLease.limiter;
```

Release from the existing outer `finally` after every file processor settles:

```ts
} finally {
  for (const unregister of unregisterTranslationControllers) unregister();
  requestRateLimiterLease.release();
}
```

Move any setup that can throw after acquisition inside this guarded region. Leave every existing `requestRateLimiter` argument unchanged so detection, analysis, translation, and retries share the lease.

- [ ] **Step 5: Run focused and complete checks**

```powershell
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/api-account.test.mts tests/request-rate-limiter.test.mts tests/request-rate-limiter-registry.test.mts
pnpm run check
git diff --check
```

Expected: PASS; no prompt, checkpoint fingerprint, output, chunk, or retry-count changes.

- [ ] **Step 6: Commit**

```powershell
git add electron/main/utils/request-rate-limiter-registry.ts tests/request-rate-limiter-registry.test.mts package.json electron/main/index.ts
git commit -m "fix: enforce account RPM across batches"
```

---

### Task 4: API-count, performance, and GUI regression coverage

**Files:**
- Modify: `e2e/example.spec.ts`

**Interfaces:**
- Extends: `startMockOpenAiServer` with one callback per HTTP request
- Verifies: two separate IPC batches share one account budget
- Verifies: exactly two detection plus two translation calls for two one-cue files

- [ ] **Step 1: Add request-start observation to the mock server**

```ts
onRequest?: (request: {
  startedAt: number;
  authorization?: string;
  bodyText: string;
}) => void;
```

Invoke it once when each chat-completion HTTP request arrives, before emitting any response or stream chunks.

- [ ] **Step 2: Write an E2E test with two simultaneous IPC calls**

Use two one-cue files, the same host/key, different target languages, `requestsPerMinute: 1_000`, `delay: 120`, `concurrency: 1`, and no context analysis. Start both `translateBatch` promises before awaiting either.

```ts
expect(requestStarts).toHaveLength(4);
for (let index = 1; index < requestStarts.length; index++) {
  expect(requestStarts[index] - requestStarts[index - 1]).toBeGreaterThanOrEqual(90);
}
expect(readFileSync(englishOutput, "utf8")).toContain("Hello");
expect(readFileSync(frenchOutput, "utf8")).toContain("Bonjour");
```

Expected before the fix: at least one near-simultaneous pair violates 90 ms. Expected after the fix: PASS with four calls, proving no extra token-producing operation.

- [ ] **Step 3: Add a zero-delay single-batch regression**

Run one one-cue task with `delay: 0` and RPM 1,000. Assert exactly two calls and normal completion. This protects single-batch throughput from artificial sleeps.

- [ ] **Step 4: Run the isolated GUI suite**

```powershell
$env:VITE_COMMIT_SHA=(git rev-parse --short=7 HEAD)
pnpm run e2e
```

Expected: every runnable test passes, including migration, same-source multilingual jobs, config restart, checkpoint warning, locale/menu, invalid batch, sponsor count, shared RPM, and zero-delay throughput.

- [ ] **Step 5: Run final verification**

```powershell
pnpm run check
git diff --check
git status --short
```

Expected: type checks, all unit tests, and Electron E2E pass; no generated screenshot remains modified; prior uncommitted feature fixes remain intact.

- [ ] **Step 6: Commit**

```powershell
git add e2e/example.spec.ts
git commit -m "test: cover account-wide RPM limiting"
```

---

## Acceptance Checklist

- [ ] Same URL/key batches share one limiter.
- [ ] Different URLs or keys remain independent.
- [ ] Lowest RPM and longest delay apply to future request starts immediately.
- [ ] Relaxing policy wakes the queue head and preserves rolling history.
- [ ] Cancellation consumes no slot and leaves no lease.
- [ ] Detection, analysis, translation, and retries all use the shared limiter.
- [ ] Single-batch throughput is unchanged.
- [ ] API request and token-producing operation counts are unchanged.
- [ ] Checkpoint, output, resume, and cleanup behavior is unchanged.
- [ ] Type checking, unit tests, Electron E2E, and diff checks all pass.
