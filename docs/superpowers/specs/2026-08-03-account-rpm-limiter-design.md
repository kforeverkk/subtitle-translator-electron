# Account-scoped RPM limiter design

## Goal

Make the configured request-per-minute limit apply across every concurrently
running batch that uses the same API account, without reducing throughput for
unrelated API accounts or changing subtitle, checkpoint, retry, and output
semantics.

An API account is identified by the normalized API base URL plus the first
non-empty API key that the translation pipeline actually uses. The key must not
appear in logs or user-facing errors; an in-memory SHA-256 digest is sufficient
for the registry identity.

## Selected approach

Add a main-process registry that owns one shared request limiter per API
account. Each `batch-translate` IPC invocation acquires an account lease before
starting work and releases it in the handler's outer `finally` block.

Every active lease contributes two policy values:

- requests per minute;
- minimum interval between request starts.

The effective account policy is always the strictest active combination:

- the lowest requests-per-minute value;
- the longest minimum interval.

When a stricter lease joins, the stricter policy applies to future request
starts immediately. Requests that have already started are not cancelled. When
a lease ends, the policy is recalculated from the remaining leases. The
registry entry is removed when its last lease ends.

The existing FIFO request queue is retained. Batch-aware round-robin scheduling
is deliberately out of scope because the current defect is limit accuracy, not
fairness, and replacing the queue would add cancellation and retry risk.

## Components and boundaries

### Account identity helper

- Normalize the API URL through `URL`, including host casing and default ports.
- Remove insignificant trailing slashes from the base path.
- Trim and select the same first valid API key used by API requests.
- Hash the key for the registry identity.
- Never log the resulting identity or raw key.

### Limiter registry

The registry exposes one operation:

```ts
acquire({ apiHost, apiKey, requestsPerMinute, minimumIntervalMs })
```

It returns a lease with:

- a `waitForSlot(signal)` function bound to the account limiter;
- an idempotent `release()` function.

The registry owns lease bookkeeping and recalculates the effective policy.
Translation code does not read or mutate registry state directly.

### Dynamic request limiter

Extend the existing limiter so its RPM and interval policy can be updated while
preserving:

- the rolling one-minute request history;
- the current FIFO queue;
- abortable waits;
- counting every real API attempt, including retries, language detection, and
  context analysis.

Changing the policy must not clear request history. Otherwise raising or
lowering RPM during active work could temporarily overspend the provider's
quota.

### IPC integration

The `batch-translate` handler acquires one lease for the whole invocation and
passes the lease's limiter interface to all files and request types in that
batch. It releases the lease only after all file processors and their retries
have settled.

Existing per-file concurrency remains unchanged. Concurrency determines how
many subtitle chunks may be ready at once; the shared limiter determines when
their API requests may start.

## Compatibility and failure behavior

- Different API URLs or keys never throttle one another.
- Multiple models on the same API account share the configured account quota.
- Existing checkpoint fingerprints and resume behavior do not change because
  RPM, delay, and concurrency do not affect translated content.
- Cancelling a task aborts its queued wait without consuming a request slot.
- A failed batch validation never acquires a lease.
- The outer `finally` release prevents stale strict policies after errors,
  cancellation, window lifecycle changes, or partial batch failure.
- Registry and limiter failures must fail the affected batch visibly; they must
  not bypass the RPM limit and continue without throttling.

## Efficiency and cost guarantees

- The change does not create additional API calls or tokens.
- Detection, analysis, translations, and retries continue to execute exactly
  once under the existing workflow; only their start times may be delayed.
- A batch running alone retains its configured RPM and interval, so ordinary
  single-batch throughput does not decrease.
- Multiple batches sharing an account may run more slowly than before only
  when the previous aggregate rate exceeded the user's configured account
  limit. This slowdown is the intended correction.
- Registry work is in-memory and constant-time for ordinary lease counts; no
  checkpoint or disk writes are added.

## Verification

### Unit tests

1. Same normalized URL and key share one limiter.
2. Different URL or key receives an independent limiter.
3. Two active leases use the lower RPM and longer interval.
4. Releasing the stricter lease restores the remaining policy without clearing
   rolling request history.
5. Releasing the final lease removes the registry entry.
6. Repeated release is harmless.
7. An aborted queued request exits promptly and does not consume a slot.
8. URL spelling differences that are semantically equivalent map to one
   account.
9. Raw API keys do not appear in exposed registry identifiers or errors.

### Integration tests

1. Two separate batch IPC calls using the same account cannot exceed their
   combined RPM.
2. A stricter second batch affects future requests from the first batch.
3. Two different accounts can obtain slots independently.
4. Detection, analysis, chunk translation, retry, cancellation, checkpoint
   resume, and successful cleanup still complete through the shared lease.

### Regression tests

- Run type checking and all unit tests.
- Run the isolated Electron GUI suite, including simultaneous task additions.
- Re-run checkpoint migration, multilingual same-source, configuration restart,
  failed IPC validation, and sponsor-count tests.
- Verify a single batch at a high test RPM has no added artificial delay.

## Out of scope

- Provider-specific token-per-minute limiting.
- Estimating or limiting monetary cost or token counts.
- Distributing limits across multiple running application processes or devices.
- Round-robin fairness between batches.
