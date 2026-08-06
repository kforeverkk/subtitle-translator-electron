# Cross-Task Input Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent any active translation output from replacing a subtitle path currently registered as an input by the same or another batch.

**Architecture:** Add a ref-counted shared input-path registry beside the existing exclusive output claims. Register all request inputs before asynchronous work, use the registry while finalizing output identities, and reject newly started inputs that are already claimed by an active writer.

**Tech Stack:** TypeScript, Node.js path/filesystem APIs, Electron IPC, Node.js test runner, Playwright Electron E2E.

## Global Constraints

- Multiple tasks may share one input path.
- Ordinary unrelated existing destinations remain overwriteable.
- Existing exclusive output claims remain unchanged.
- Output collisions with protected inputs repeat the current language suffix.
- Retry at most 100 protected-input filename collisions.
- One invalid or blocked input must not fail unrelated files in the request.
- Cross-task protection must not change API traffic, RPM, Token use, or checkpoint schema.

---

### Task 1: Shared Input Claim Registry

**Files:**
- Modify: `electron/main/utils/path-claims.ts`
- Modify: `tests/path-claims.test.mts`

- [ ] Add failing tests for shared registration, duplicate readers, independent batch release, and active-writer blocking.
- [ ] Implement ref-counted registration helpers.
- [ ] Run focused path-claim tests.

### Task 2: Repeated Protected-Input Output Resolution

**Files:**
- Modify: `electron/main/utils/output-path.ts`
- Modify: `tests/output-path.test.mts`

- [ ] Add failing tests for one collision, repeated collisions, safe checkpoint reuse, and the 100-attempt limit.
- [ ] Extend `getSafeTranslationOutputIdentity` with a protected-input predicate.
- [ ] Preserve unrelated existing destination overwrite behavior.
- [ ] Run focused output-path tests.

### Task 3: Batch Lifecycle Integration

**Files:**
- Modify: `electron/main/index.ts`
- Modify: `tests/path-claims.test.mts`

- [ ] Register all request input keys before entering the async pool.
- [ ] Mark only inputs already held by active output writers as blocked.
- [ ] Pass the active input predicate into output identity resolution.
- [ ] Release batch input claims in the outer `finally`.
- [ ] Run focused tests and both TypeScript checks.

### Task 4: Electron Regression

**Files:**
- Modify: `e2e/example.spec.ts`

- [ ] Add a same-request case where one output equals a later input and assert the input is unchanged.
- [ ] Verify repeated suffix output naming.
- [ ] Verify shared same-source translation remains allowed.
- [ ] Add a cross-request active writer/input conflict case if the existing E2E harness can deterministically pause the writer.
- [ ] Build and run focused E2E.

### Task 5: Full Verification

- [ ] Run both TypeScript checks.
- [ ] Run all Node tests.
- [ ] Build the Electron test application.
- [ ] Run all Electron E2E.
- [ ] Commit only the scoped source, tests, design, and plan.
