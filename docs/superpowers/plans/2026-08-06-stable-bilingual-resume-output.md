# Stable Bilingual Resume Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the first resolved bilingual output filename across compatible checkpoint resumes while allowing the user to change only the output directory.

**Architecture:** Extend the existing version 3 checkpoint document with an optional, strictly validated output identity containing the output format, detected source language, and safe generated filename. Move output-identity selection into focused utilities so compatible resumes can reuse it, legacy checkpoints can backfill it, and format/config changes can deliberately resolve a new identity.

**Tech Stack:** TypeScript, Node.js test runner, Electron IPC, Playwright Electron E2E.

## Global Constraints

- Keep checkpoint `version: 3`; all existing v1/v2/v3 documents remain readable.
- Never trust or persist an absolute output directory in checkpoint metadata.
- Reuse a stored filename only when translation configuration and output format match.
- A user-selected output directory may change without changing the stored filename.
- Preserve existing output-path collision claims, source identity checks, checkpoint backup ownership, and translated-only overwrite protection.
- Do not include the existing `e2e/screenshots/example.png` test artifact in any commit.

---

### Task 1: Checkpoint Output Identity Validation

**Files:**
- Modify: `electron/main/utils/output-path.ts`
- Modify: `electron/main/utils/translate.ts`
- Test: `tests/output-path.test.mts`
- Test: `tests/translation-checkpoint.test.mts`

**Interfaces:**
- Produces: `TranslationOutputIdentity`
- Produces: `createTranslationOutputIdentity(...)`
- Produces: `isReusableTranslationOutputIdentity(...)`
- Produces: `getTranslatedPathFromOutputIdentity(...)`
- Extends: `TranslationCacheDocument.output?: TranslationOutputIdentity`

- [ ] **Step 1: Write failing output identity tests**

Add literal assertions proving that:

```ts
const identity = createTranslationOutputIdentity(
  path.join("subtitles", "movie.srt"),
  "srt-bilingual",
  "movie.srt",
  "English",
  "Chinese"
);
assert.deepEqual(identity, {
  format: "srt-bilingual",
  detectedSourceLanguage: "Chinese",
  fileName: "movie.en-zh.srt",
});
assert.equal(
  getTranslatedPathFromOutputIdentity(
    path.join("subtitles", "movie.srt"),
    path.join("other-output"),
    identity
  ),
  path.join("other-output", "movie.en-zh.srt")
);
```

Add rejection/reuse cases for absolute names, separators, `.`/`..`, wrong extension, and output-format mismatch.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/output-path.test.mts tests/translation-checkpoint.test.mts
```

Expected: FAIL because the output identity APIs and checkpoint field do not exist.

- [ ] **Step 3: Implement the minimal output identity utilities**

In `output-path.ts`, create and validate an identity from the existing generated path. Accept only `path.basename(fileName) === fileName`, non-empty names other than `.`/`..`, matching `.srt`/`.ass` extension, matching current format, and a finite string source-language value.

`getTranslatedPathFromOutputIdentity` must combine:

```ts
path.join(
  outputDirectory ?? path.dirname(inputPath),
  identity.fileName
)
```

It must never read a directory from the checkpoint.

- [ ] **Step 4: Extend checkpoint serialization and parsing**

Add optional `output` data to `TranslationCacheDocument`, `createTranslationCacheDocument`, and `parseTranslationCache`. Missing output remains valid. Present-but-invalid output makes the checkpoint invalid so unsafe metadata cannot reach file writes.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```powershell
git add electron/main/utils/output-path.ts electron/main/utils/translate.ts tests/output-path.test.mts tests/translation-checkpoint.test.mts
git commit -m "feat: persist safe translation output identity"
```

### Task 2: Compatible Resume Selection and Legacy Backfill

**Files:**
- Modify: `electron/main/index.ts`
- Modify: `electron/main/utils/translate.ts`
- Test: `tests/translation-checkpoint.test.mts`

**Interfaces:**
- Consumes: `TranslationCacheDocument.output`
- Consumes: output identity utilities from Task 1
- Produces: compatible resume skips language detection and uses the stored filename

- [ ] **Step 1: Write failing resume-selection tests**

Add tests around a focused selection helper proving:

- Matching config plus matching format returns the stored identity and does not request detection.
- Missing legacy output identity requests detection and returns a newly generated identity.
- A restarted translation ignores the old output identity.
- A changed output format ignores the old identity and resolves a new filename.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/output-path.test.mts tests/translation-checkpoint.test.mts
```

Expected: FAIL because batch translation always detects language and always calls `getTranslatedPath`.

- [ ] **Step 3: Implement resume output selection**

In `batch-translate`:

1. Check whether `input.cacheDocument?.output` is reusable for `params.outputFormat`.
2. Reuse it only when `input.shouldRestartTranslation` is false.
3. If reusable, skip `detectSubtitleLanguage`.
4. Otherwise run the existing retrying detection and create a fresh identity.
5. Resolve the final path from the current output directory plus the identity filename.

- [ ] **Step 4: Persist and backfill the selected identity**

Pass the selected identity into every `createTranslationCacheDocument` call made by the checkpoint writer. A legacy checkpoint therefore gains the field on its next atomic save. Existing analysis, source fingerprint, task ID, and translated cues remain unchanged.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```powershell
git add electron/main/index.ts electron/main/utils/translate.ts tests/translation-checkpoint.test.mts tests/output-path.test.mts
git commit -m "fix: keep bilingual resume output filename stable"
```

### Task 3: Real Electron Resume Regression

**Files:**
- Modify: `e2e/example.spec.ts`

**Interfaces:**
- Exercises: real `window.electronAPI.translateBatch`
- Exercises: real checkpoint serialization, application restart, language detection, output writes, and path claims

- [ ] **Step 1: Write the failing E2E test**

Create a mock API sequence that:

1. Detects `Chinese`.
2. Produces one translated chunk.
3. Fails a later translation and leaves a checkpoint plus `movie.en-zh.srt`.
4. Restarts Electron and resumes the same task/config.
5. Would return `Japanese` if an unexpected second language-detection request occurs.
6. Finishes translation.

Assert:

```ts
expect(languageDetectionRequestCount).toBe(1);
expect(existsSync(path.join(tempDir, "movie.en-zh.srt"))).toBe(true);
expect(existsSync(path.join(tempDir, "movie.en-ja.srt"))).toBe(false);
expect(existsSync(path.join(tempDir, "movie.en-original.srt"))).toBe(false);
```

Also add a legacy-checkpoint case that verifies one detection and a persisted `output` identity before completion cleanup.

- [ ] **Step 2: Run the new E2E test and verify RED**

Run:

```powershell
& .\node_modules\.bin\playwright.cmd test e2e/example.spec.ts --grep "bilingual resume keeps"
```

Expected: FAIL because resume performs a second language detection and changes the path when its result differs.

- [ ] **Step 3: Make only integration adjustments required by the test**

If the unit-level implementation does not expose the selected output identity to all checkpoint writes or progress events, correct that data flow without changing unrelated translation behavior.

- [ ] **Step 4: Run the new E2E test and verify GREEN**

Run the command from Step 2. Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add e2e/example.spec.ts electron/main/index.ts electron/main/utils/translate.ts
git commit -m "test: cover stable bilingual checkpoint resume"
```

### Task 4: Full Regression Verification

**Files:**
- No production changes expected

**Interfaces:**
- Verifies all existing subtitle formats, checkpoint migrations, retry logic, source identity, GUI lifecycle, sponsorship behavior, and shared RPM behavior remain intact.

- [ ] **Step 1: Run TypeScript checks**

```powershell
& .\node_modules\.bin\tsc.cmd --noEmit
& .\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
```

Expected: both exit with code 0.

- [ ] **Step 2: Run all unit tests**

Run the complete test command declared in `package.json` directly with Node if local pnpm remains unavailable. Expected: zero failures.

- [ ] **Step 3: Build the Electron test application**

```powershell
& .\node_modules\.bin\vite.cmd build --mode=test
```

Expected: exit with code 0.

- [ ] **Step 4: Run the full Electron E2E suite**

```powershell
& .\node_modules\.bin\playwright.cmd test
```

Expected: all runnable tests pass; the packaged-Windows conditional test may remain skipped when its isolated package is absent.

- [ ] **Step 5: Inspect the final diff**

Run `git diff --check`, confirm no unrelated files are staged, and confirm `e2e/screenshots/example.png` remains excluded.

- [ ] **Step 6: Commit any final test-only corrections**

Only if Step 1–5 required a scoped correction:

```powershell
git add <scoped-files>
git commit -m "test: complete bilingual resume regression coverage"
```
