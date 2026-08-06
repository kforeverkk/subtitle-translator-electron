# Required Content Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require every subtitle with at least 20 cues to persist a valid plot summary and glossary before any translation request can begin.

**Architecture:** Add a pure analysis-requirement planner that distinguishes short subtitles, reusable analyzed checkpoints, fresh long tasks, and legacy partial checkpoints missing analysis. The Electron batch pipeline will use that decision to restart unsafe legacy progress, run the existing three-attempt analysis flow as a hard prerequisite, persist the analysis atomically, and only then dispatch translation chunks.

**Tech Stack:** TypeScript, Node.js test runner, Electron IPC, Zod structured output validation, Playwright Electron E2E.

## Global Constraints

- 0–19 cues do not require content analysis.
- 20 or more cues require content analysis.
- A valid analysis requires a non-empty `plotSummary` and a present, structurally valid `glossary` array.
- An empty glossary array is valid.
- Analysis uses exactly the existing maximum of three automatic attempts.
- After the third failed analysis attempt, no translation request may start.
- A matching checkpoint with valid analysis reuses it without another analysis request.
- A content-configuration change clears old analysis and translations, then analyzes again.
- A legacy long checkpoint with translated cues but no analysis must back up old progress and restart from zero.
- A successful analysis must be atomically persisted before the first translation request.
- The existing `e2e/screenshots/example.png` difference must remain uncommitted.

---

### Task 1: Analysis Requirement and Legacy Restart Decision

**Files:**
- Modify: `electron/main/utils/subtitle-sampling.ts`
- Test: `tests/subtitle-sampling.test.mts`

**Interfaces:**
- Produces:

```ts
export interface SubtitleAnalysisPlan {
  requiresAnalysis: boolean;
  shouldAnalyze: boolean;
  shouldRestartForMissingAnalysis: boolean;
}

export function getSubtitleAnalysisPlan(
  cachedAnalysis: string | undefined,
  subtitleCount: number,
  completedSubtitleCount: number,
  minimumSubtitleCount: number
): SubtitleAnalysisPlan;
```

- [ ] **Step 1: Write the failing boundary and restart tests**

Add literal assertions:

```ts
assert.deepEqual(getSubtitleAnalysisPlan(undefined, 19, 0, 20), {
  requiresAnalysis: false,
  shouldAnalyze: false,
  shouldRestartForMissingAnalysis: false,
});
assert.deepEqual(getSubtitleAnalysisPlan(undefined, 20, 0, 20), {
  requiresAnalysis: true,
  shouldAnalyze: true,
  shouldRestartForMissingAnalysis: false,
});
assert.deepEqual(getSubtitleAnalysisPlan(undefined, 20, 5, 20), {
  requiresAnalysis: true,
  shouldAnalyze: true,
  shouldRestartForMissingAnalysis: true,
});
assert.deepEqual(getSubtitleAnalysisPlan("Existing context", 20, 5, 20), {
  requiresAnalysis: true,
  shouldAnalyze: false,
  shouldRestartForMissingAnalysis: false,
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-sampling.test.mts
```

Expected: FAIL because `getSubtitleAnalysisPlan` does not exist and the current threshold behavior treats 20 cues according to the caller’s old value of 40.

- [ ] **Step 3: Implement the pure planner**

Calculate:

```ts
const requiresAnalysis = subtitleCount >= minimumSubtitleCount;
const hasAnalysis = Boolean(cachedAnalysis?.trim());
const shouldAnalyze = requiresAnalysis && !hasAnalysis;
const shouldRestartForMissingAnalysis =
  shouldAnalyze && completedSubtitleCount > 0;
```

Return all three booleans. Preserve `shouldAnalyzeSubtitles` only if another caller still uses it; otherwise replace it with the planner.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: all subtitle-sampling tests pass.

- [ ] **Step 5: Commit**

```powershell
git add electron/main/utils/subtitle-sampling.ts tests/subtitle-sampling.test.mts
git commit -m "feat: define required subtitle analysis plan"
```

### Task 2: Enforce Analysis Before Translation

**Files:**
- Modify: `electron/main/index.ts`
- Modify: `electron/shared/translation-error-codes.ts`
- Modify: `src/utils/translation-error.ts`
- Modify: `src/i18n-messages.ts`
- Modify: `src/locales/en-US.po`
- Modify: `src/locales/zh-CN.po`
- Modify: `src/locales/zh-TW.po`
- Test: `tests/translation-error.test.mts`
- Test: `tests/translation-checkpoint.test.mts`

**Interfaces:**
- Consumes: `getSubtitleAnalysisPlan(...)`
- Produces: `translationErrorCodes.requiredAnalysisCheckpoint`
- Produces: localized `error.requiredAnalysisCheckpoint`

- [ ] **Step 1: Write failing localization and restart tests**

Add a translation-error assertion that the new code maps to a clear localized message:

```ts
getLocalizedTranslationError(
  new Error(translationErrorCodes.requiredAnalysisCheckpoint),
  "fallback",
  t
)
```

must return a message explaining that the required analysis result could not be saved and translation did not start.

Add a checkpoint decision test proving a long partial checkpoint without analysis is marked for restart while a short checkpoint is not.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-sampling.test.mts tests/translation-checkpoint.test.mts tests/translation-error.test.mts
```

Expected: FAIL because the required checkpoint error and main restart integration are not implemented.

- [ ] **Step 3: Integrate the analysis plan into batch translation**

In `electron/main/index.ts`:

1. Change `MIN_CUES_FOR_CONTEXT_ANALYSIS` from `40` to `20`.
2. Count completed cues before clearing anything.
3. Build `analysisPlan` from cached analysis, total cues, completed cues, and the threshold.
4. Treat `analysisPlan.shouldRestartForMissingAnalysis` like an incompatible checkpoint restart:
   - preserve the old checkpoint source;
   - clear all old cue translations;
   - reset completed cues to zero;
   - clear analysis data.
5. Recompute the plan after clearing so the task requires a fresh analysis.

- [ ] **Step 4: Make analysis a hard prerequisite**

Replace the current catch-and-continue behavior:

```ts
const analysis = await retryTranslation(...);
analysisData = analysis;
analysisCache.set(file.taskId, analysis);
await persistRequiredCheckpoint();
```

If `retryTranslation` throws after its third attempt, allow the error to reach the existing task error handler. Do not send a `translating` progress event, call `translateSubtitleChunk`, or write a translated output file.

- [ ] **Step 5: Require durable analysis persistence**

Extend checkpoint persistence with a required mode:

```ts
const saved = await persistCheckpoint();
if (!saved) {
  throw new Error(translationErrorCodes.requiredAnalysisCheckpoint);
}
```

Use required mode immediately after successful analysis and before the first translation request. Keep ordinary per-chunk checkpoint saves non-fatal as they are today.

- [ ] **Step 6: Add the error code and translations**

Add:

```ts
requiredAnalysisCheckpoint:
  "ERR_REQUIRED_ANALYSIS_CHECKPOINT_SAVE_FAILED"
```

Map it to `error.requiredAnalysisCheckpoint`. Add equivalent English, Simplified Chinese, and Traditional Chinese messages stating that translation did not start because the required analysis result could not be saved.

- [ ] **Step 7: Run focused tests and TypeScript checks**

Run the Step 2 tests, then:

```powershell
& .\node_modules\.bin\tsc.cmd --noEmit
& .\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
```

Expected: all focused tests and both type checks pass.

- [ ] **Step 8: Commit**

```powershell
git add electron/main/index.ts electron/shared/translation-error-codes.ts src/utils/translation-error.ts src/i18n-messages.ts src/locales/en-US.po src/locales/zh-CN.po src/locales/zh-TW.po tests/translation-error.test.mts tests/translation-checkpoint.test.mts
git commit -m "fix: require content analysis before long translations"
```

### Task 3: Structured Analysis Contract

**Files:**
- Modify: `tests/analysis-output.test.mts`
- Modify only if needed: `electron/main/utils/analysis-output.ts`

**Interfaces:**
- Exercises: `subtitleAnalysisSchema`
- Exercises: `formatSubtitleAnalysis`

- [ ] **Step 1: Add contract tests**

Add explicit cases proving:

```ts
subtitleAnalysisSchema.safeParse({
  plotSummary: "A complete summary.",
}).success === false;

subtitleAnalysisSchema.safeParse({
  plotSummary: "A complete summary.",
  glossary: [],
}).success === true;
```

Also reject a missing/empty summary and malformed glossary entry.

- [ ] **Step 2: Run analysis tests**

```powershell
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/analysis-output.test.mts
```

Expected: the existing schema should already satisfy the contract. If any case fails, make only the minimum schema correction and rerun.

- [ ] **Step 3: Commit**

```powershell
git add tests/analysis-output.test.mts electron/main/utils/analysis-output.ts
git commit -m "test: lock required analysis structure"
```

### Task 4: Real Electron Analysis Gate Regression

**Files:**
- Modify: `e2e/example.spec.ts`

**Interfaces:**
- Exercises: real analysis requests, retry policy, checkpoint writes, translation request gating, restart behavior, and cached analysis reuse.

- [ ] **Step 1: Extend the mock server to distinguish request types**

Classify non-stream `/chat/completions` requests by their system/prompt content:

- language detection response: `{ language: "Chinese" }`;
- content analysis response: `{ plotSummary: "...", glossary: [] }`;
- configurable malformed/error analysis responses for failure tests.

Track separate counters for language detection, analysis, and stream translation requests.

- [ ] **Step 2: Write the failing 20-cue analysis-gate E2E**

Configure three retryable analysis failures for a 20-cue subtitle. Assert:

```ts
expect(analysisRequestCount).toBe(3);
expect(translationRequestCount).toBe(0);
expect(progress.status).toBe("error");
expect(existsSync(expectedOutputPath)).toBe(false);
```

- [ ] **Step 3: Write cached-analysis resume E2E**

Let analysis succeed, translate one block, then fail a later block and leave a checkpoint. Relaunch with the same task/config and assert:

```ts
expect(analysisRequestCount).toBe(1);
expect(resumedProgress.status).toBe("done");
```

The resumed translation request must contain the same formatted plot summary and explicit glossary section.

- [ ] **Step 4: Write legacy partial checkpoint restart E2E**

Create a 20+ cue checkpoint with translated cues but no analysis. Assert that:

- old translations are not sent to the final output;
- analysis runs before translation;
- translation restarts from the first cue;
- the old checkpoint is preserved according to existing backup ownership rules until success cleanup.

- [ ] **Step 5: Run focused E2E and verify RED/GREEN**

Before production integration, the analysis-failure test must fail because current code continues into translation. After Tasks 1–2, run:

```powershell
& .\node_modules\.bin\vite.cmd build --mode=test
& .\node_modules\.bin\playwright.cmd test e2e/example.spec.ts --grep "required content analysis|cached analysis resume|legacy analysis restart"
```

Expected: all new focused E2E tests pass.

- [ ] **Step 6: Commit**

```powershell
git add e2e/example.spec.ts
git commit -m "test: cover required content analysis lifecycle"
```

### Task 5: Full Regression Verification

**Files:**
- No production changes expected

**Interfaces:**
- Verifies output identity, checkpoint migration, source identity, encoding, SSA conversion, retry handling, RPM limiting, sponsorship prompts, and Electron lifecycle remain intact.

- [ ] **Step 1: Run TypeScript checks**

```powershell
& .\node_modules\.bin\tsc.cmd --noEmit
& .\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
```

- [ ] **Step 2: Run all unit tests**

Run the complete Node test command declared in `package.json`. Expected: zero failures.

- [ ] **Step 3: Rebuild the Electron test application**

```powershell
& .\node_modules\.bin\vite.cmd build --mode=test
```

- [ ] **Step 4: Run all Electron E2E tests**

```powershell
& .\node_modules\.bin\playwright.cmd test
```

Expected: all runnable tests pass; the packaged Windows conditional test may remain skipped.

- [ ] **Step 5: Inspect repository scope**

Run `git diff --check`, inspect commits since `2.1.4`, and confirm `e2e/screenshots/example.png` remains uncommitted.
