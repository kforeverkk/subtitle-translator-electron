# Self Input/Output Collision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a task from writing its translated subtitle over its own current input while preserving intentional overwrites of other existing output files.

**Architecture:** Use one collision fallback for translated-only and bilingual formats, plus a final-path output-identity sanitizer used after fresh generation or checkpoint reuse. The fallback retains the current input basename and appends the newly generated language suffix; unrelated existing destinations remain overwriteable.

**Tech Stack:** TypeScript, Node.js path utilities, Electron main process, Node.js test runner, Playwright Electron E2E.

## Global Constraints

- Only protect the current task's exact input path.
- Do not add numbered output filenames.
- Do not test for ordinary destination existence.
- Continue overwriting unrelated existing output files.
- Use the same repeated-language-suffix fallback for translated-only and bilingual output.
- Preserve already-safe legacy checkpoint file names instead of migrating them.
- Apply protection to fresh and checkpoint-resumed output identities.
- Do not change cross-task path claims in this work.

---

### Task 1: Bilingual Self-Collision Naming

**Files:**
- Modify: `tests/output-path.test.mts`
- Modify: `electron/main/utils/output-path.ts`

- [ ] Add failing assertions for SRT/ASS, both bilingual orders, and unknown language fallbacks.
- [ ] Verify the current output identity resolves to the input path.
- [ ] Add a final-path output-identity sanitizer so bilingual self-collisions append the generated suffix to the unstripped source basename.
- [ ] Run `tests/output-path.test.mts` and verify all assertions pass.

### Task 2: Checkpoint Output Identity Safety

**Files:**
- Modify: `tests/output-path.test.mts`
- Modify: `electron/main/utils/output-path.ts`
- Modify: `electron/main/index.ts`

- [ ] Add failing tests for a dangerous cached identity and a safe unchanged identity.
- [ ] Complete `getSafeTranslationOutputIdentity(...)` coverage for translated-only and safe unchanged identities.
- [ ] Apply the helper after fresh generation or checkpoint reuse and before constructing the writer and path claims.
- [ ] Run focused tests and both TypeScript checks.

### Task 3: Real Electron Regression

**Files:**
- Modify: `e2e/example.spec.ts`

- [ ] Add a bilingual task whose input is `movie.en-zh.srt`.
- [ ] Assert the input bytes remain unchanged.
- [ ] Assert output is `movie.en-zh.en-zh.srt`.
- [ ] Add or retain an assertion that an unrelated existing normal destination is overwritten, not numbered.
- [ ] Build the test app and run the focused E2E.

### Task 4: Full Verification

- [ ] Run both TypeScript checks.
- [ ] Run all Node tests.
- [ ] Build the Electron test app.
- [ ] Run all Electron E2E.
- [ ] Commit only the scoped code, tests, spec, and plan.
