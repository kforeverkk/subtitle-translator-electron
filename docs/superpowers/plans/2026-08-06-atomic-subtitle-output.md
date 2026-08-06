# Atomic Subtitle Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unsafe direct subtitle overwrites with ordered, retryable atomic output commits that preserve the last valid subtitle on every failure.

**Architecture:** Add a subtitle-specific atomic writer with unique same-directory temporary files and bounded Windows rename retries. Separate subtitle serialization from file I/O, then give each translation task one recovering serial output queue so concurrent chunk completions cannot commit snapshots out of order. Partial preview failures remain non-fatal, while the final output commit must succeed before checkpoint cleanup and task completion.

**Tech Stack:** TypeScript, Node.js filesystem promises, Node.js test runner, Electron IPC, Playwright Electron E2E.

## Global Constraints

- Never fall back to truncating or directly overwriting the destination after a failed rename.
- Temporary files must be unique and located beside the destination.
- Temporary files must be written as UTF-8 with `flush: true`.
- Windows retries apply only to `EACCES`, `EBUSY`, and `EPERM`.
- Retry delays are exactly `25`, `50`, `100`, and `200` milliseconds.
- A failed partial preview save does not fail translation or prevent checkpoint persistence.
- A failed final subtitle save fails the task and preserves its checkpoint.
- SRT, ASS, bilingual, translated-only, output naming, checkpoint schema, and translation behavior must remain unchanged.
- `e2e/screenshots/example.png` must remain uncommitted.

---

### Task 1: Subtitle-Specific Atomic File Writer

**Files:**
- Create: `electron/main/utils/subtitle-file-writer.ts`
- Create: `tests/subtitle-file-writer.test.mts`
- Modify: `package.json`

**Interfaces:**
- Produces:

```ts
export const WINDOWS_SUBTITLE_RENAME_RETRY_DELAYS_MS =
  [25, 50, 100, 200] as const;

export interface SubtitleAtomicWriteOptions {
  platform?: NodeJS.Platform;
  retryDelaysMs?: readonly number[];
  renameFile?: (temporaryPath: string, outputPath: string) => Promise<void>;
  writeFile?: (
    temporaryPath: string,
    content: string,
    options: { encoding: "utf8"; flush: true }
  ) => Promise<void>;
  unlinkFile?: (temporaryPath: string) => Promise<void>;
  wait?: (delayMs: number) => Promise<void>;
  createTemporaryPath?: (outputPath: string) => string;
}

export async function writeSubtitleOutputAtomically(
  outputPath: string,
  content: string,
  options?: SubtitleAtomicWriteOptions
): Promise<void>;
```

- [ ] **Step 1: Write failing success, retry, preservation, and cleanup tests**

Create real temporary directories and literal old/new subtitle contents. Cover:

```ts
test("atomically replaces a subtitle from a unique same-directory temporary file")
test("retries transient Windows rename failures before committing")
test("preserves the last valid subtitle when Windows retries are exhausted")
test("does not retry deterministic or non-Windows rename failures")
test("keeps the rename error when temporary cleanup also fails")
```

The preservation test must create `movie.en.srt` containing `"last valid subtitle"`, make every injected rename throw an `EPERM` error, and assert the destination still contains that exact literal after rejection.

The success test must capture the temporary path and assert:

```ts
assert.equal(path.dirname(temporaryPath), temporaryDirectory);
assert.match(path.basename(temporaryPath), /^movie\.en\.srt\.\d+\..+\.tmp$/);
assert.equal(await readFile(outputPath, "utf8"), "complete new subtitle");
```

The retry test must assert five maximum rename attempts and the exact delay sequence `[25, 50, 100, 200]`.

- [ ] **Step 2: Run the new test and verify RED**

```powershell
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-file-writer.test.mts
```

Expected: FAIL because `subtitle-file-writer.ts` does not exist.

- [ ] **Step 3: Implement the minimal atomic writer**

Use `randomUUID`, `fs.promises.writeFile`, `fs.promises.rename`, `fs.promises.unlink`, and `node:timers/promises`.

The implementation must:

```ts
const temporaryPath =
  options.createTemporaryPath?.(outputPath) ??
  `${outputPath}.${process.pid}.${randomUUID()}.tmp`;

await writeFile(temporaryPath, content, {
  encoding: "utf8",
  flush: true,
});
```

Retry only the three transient Windows codes. Track `committed`; in `finally`, delete the temporary file only when not committed. If cleanup fails with anything other than `ENOENT`, log it without replacing the primary error.

- [ ] **Step 4: Add the test file to the project test script**

Add `tests/subtitle-file-writer.test.mts` to `package.json` immediately before the existing subtitle output tests.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all new tests pass with zero failures.

- [ ] **Step 6: Commit**

```powershell
git add electron/main/utils/subtitle-file-writer.ts tests/subtitle-file-writer.test.mts package.json
git commit -m "feat: add atomic subtitle output writer"
```

### Task 2: Recovering Serial Subtitle Writer

**Files:**
- Modify: `electron/main/utils/subtitle-file-writer.ts`
- Modify: `tests/subtitle-file-writer.test.mts`

**Interfaces:**
- Consumes: `writeSubtitleOutputAtomically(outputPath, content, options)`
- Produces:

```ts
export type SubtitleOutputWrite = (
  outputPath: string,
  content: string
) => Promise<void>;

export function createSubtitleOutputWriter(
  outputPath: string,
  writeOutput?: SubtitleOutputWrite
): {
  write: (content: string) => Promise<void>;
  wait: () => Promise<void>;
};
```

- [ ] **Step 1: Write failing ordering and recovery tests**

Add:

```ts
test("serial subtitle writer commits snapshots in enqueue order")
test("serial subtitle writer recovers after one failed write")
```

For ordering, hold the first injected write open, enqueue `"snapshot A"` and `"snapshot B"`, and assert `"snapshot B"` cannot start until the first promise is released.

For recovery, make the first injected write reject and the second succeed. Assert the first returned promise rejects, the second resolves, and the successful write receives `"latest complete snapshot"`.

- [ ] **Step 2: Run focused tests and verify RED**

Run the Task 1 focused test command. Expected: FAIL because `createSubtitleOutputWriter` does not exist.

- [ ] **Step 3: Implement the recovering queue**

Maintain one `pending: Promise<void>`. Each `write(content)` must append to the queue using:

```ts
const current = pending
  .catch(() => undefined)
  .then(() => writeOutput(outputPath, content));
pending = current;
return current;
```

`wait()` returns the current pending promise. Do not coalesce or reorder snapshots.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Task 1 focused test command. Expected: ordering and recovery tests pass.

- [ ] **Step 5: Commit**

```powershell
git add electron/main/utils/subtitle-file-writer.ts tests/subtitle-file-writer.test.mts
git commit -m "feat: serialize subtitle output commits"
```

### Task 3: Separate Subtitle Serialization from File I/O

**Files:**
- Modify: `electron/main/utils/translate.ts`
- Modify: `tests/subtitle-encoding-integration.test.mts`
- Modify: `tests/ssa-translation-integration.test.mts`
- Modify: `tests/subtitle-output-format.test.mts`

**Interfaces:**
- Produces:

```ts
export function serializeTranslatedSubtitle(
  parsedSubtitle: ParsedSubtitle,
  outputFormat: SubtitleOutputFormat,
  assFonts?: AssBilingualFontOptions,
  sourceFormat?: SubtitleFileExtension
): string;
```

- Removes production use of synchronous `saveTranslated(outputPath, ...)`.

- [ ] **Step 1: Write failing serialization tests**

Convert the two integration tests that currently call `saveTranslated` so they call `serializeTranslatedSubtitle`, explicitly write the returned string where a physical file is needed, and continue asserting:

- legacy source output is strict UTF-8;
- SSA input retains its lossless ASS conversion behavior.

Add direct assertions in `tests/subtitle-output-format.test.mts` that representative SRT and ASS serialization returns the expected complete text without creating a file.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-output-format.test.mts tests/subtitle-encoding-integration.test.mts tests/ssa-translation-integration.test.mts
```

Expected: FAIL because `serializeTranslatedSubtitle` is not exported.

- [ ] **Step 3: Refactor `saveTranslated` into pure serialization**

Rename the existing function to `serializeTranslatedSubtitle`, remove `outputPath`, preserve every existing SRT/ASS/SSA formatting branch, and return `newSubtitle`.

Delete the fixed `.tmp` write, rename, direct-overwrite fallback, and temporary cleanup block. Export `serializeTranslatedSubtitle`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all existing format and encoding assertions pass.

- [ ] **Step 5: Commit**

```powershell
git add electron/main/utils/translate.ts tests/subtitle-output-format.test.mts tests/subtitle-encoding-integration.test.mts tests/ssa-translation-integration.test.mts
git commit -m "refactor: separate subtitle serialization from writes"
```

### Task 4: Integrate Ordered Atomic Writes into Translation

**Files:**
- Modify: `electron/main/index.ts`
- Modify: `electron/main/utils/subtitle-file-writer.ts`
- Modify: `tests/subtitle-file-writer.test.mts`

**Interfaces:**
- Consumes:
  - `serializeTranslatedSubtitle(...)`
  - `createSubtitleOutputWriter(outputPath, writeOutput?)`
- Produces task behavior:
  - partial save failure is logged and translation continues;
  - final save failure reaches the existing task error handler;
  - checkpoint cleanup happens only after final output success.

- [ ] **Step 1: Add a failing lifecycle helper test**

Add a small exported helper to the planned interface:

```ts
export async function writeFinalSubtitleOutput(
  writer: ReturnType<typeof createSubtitleOutputWriter>,
  finalContent: string
): Promise<void>;
```

Write a test proving it waits for an earlier queued partial write, then commits the final content, and rejects when the final commit fails. This test protects the required ordering before checkpoint cleanup.

- [ ] **Step 2: Run focused test and verify RED**

Run the subtitle writer test command. Expected: FAIL because `writeFinalSubtitleOutput` does not exist.

- [ ] **Step 3: Implement the final-write helper**

Implement:

```ts
await writer.wait().catch(() => undefined);
await writer.write(finalContent);
```

Ignoring a previous partial error is intentional; the new final commit remains mandatory.

- [ ] **Step 4: Replace all three `saveTranslated` call sites**

For each file task, create one writer after the final output path is known:

```ts
const subtitleOutputWriter =
  createSubtitleOutputWriter(translatedOutputPath);
```

Handle the no-chunk path with one mandatory final serialization and atomic write before checkpoint cleanup.

For partial previews:

```ts
const partialContent = serializeTranslatedSubtitle(...);
await subtitleOutputWriter.write(partialContent).catch((error) => {
  console.warn(
    `Failed to atomically write partial translated file: ${translatedOutputPath}`,
    error
  );
});
await persistCheckpoint();
```

For final output:

```ts
const finalContent = serializeTranslatedSubtitle(...);
await writeFinalSubtitleOutput(subtitleOutputWriter, finalContent);
await checkpointWriter.wait().catch(...);
await removeSuccessfulCheckpointArtifacts();
```

The mandatory final write must remain before checkpoint removal and the `"done"` progress event.

- [ ] **Step 5: Run writer tests and TypeScript checks**

```powershell
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-file-writer.test.mts tests/subtitle-output-format.test.mts tests/subtitle-encoding-integration.test.mts tests/ssa-translation-integration.test.mts
& .\node_modules\.bin\tsc.cmd --noEmit
& .\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
```

Expected: all focused tests and both checks pass.

- [ ] **Step 6: Commit**

```powershell
git add electron/main/index.ts electron/main/utils/subtitle-file-writer.ts tests/subtitle-file-writer.test.mts
git commit -m "fix: preserve valid subtitles on output failure"
```

### Task 5: Real Electron Output Failure Regression

**Files:**
- Modify: `electron/main/index.ts`
- Modify: `e2e/example.spec.ts`

**Interfaces:**
- Adds an E2E-only main-process hook, available only when `SUBTITLE_TRANSLATOR_E2E_USER_DATA` is set:

```ts
globalThis.__subtitleTranslatorOutputRenameHook?: (
  temporaryPath: string,
  outputPath: string
) => Promise<void>;
```

- Production runs always use `fs.promises.rename`.

- [ ] **Step 1: Add the failing E2E scenario**

Create a real translation task with:

- an existing output file containing `"last valid subtitle"`;
- a valid checkpoint path;
- a main-process rename hook that throws an `EPERM` filesystem-shaped error for every subtitle output rename but not checkpoint renames.

Assert after the task fails:

```ts
expect(await readFile(outputPath, "utf8")).toBe("last valid subtitle");
expect(existsSync(checkpointPath)).toBe(true);
expect(progress.status).toBe("error");
```

Also assert no matching subtitle `.tmp` artifact remains.

- [ ] **Step 2: Build and run the focused E2E to verify RED**

```powershell
& .\node_modules\.bin\vite.cmd build --mode=test
& .\node_modules\.bin\playwright.cmd test e2e/example.spec.ts --grep "subtitle output rename failure"
```

Expected: FAIL because the main process has no injectable output rename hook and the current writer still cannot exercise the forced failure.

- [ ] **Step 3: Wire the E2E-only rename dependency**

When creating the task writer, select:

```ts
const renameFile =
  e2eUserDataPath &&
  globalThis.__subtitleTranslatorOutputRenameHook
    ? globalThis.__subtitleTranslatorOutputRenameHook
    : undefined;
```

Pass it only through `writeSubtitleOutputAtomically` options. Delete/reset the hook in E2E cleanup so later tests use real filesystem behavior.

- [ ] **Step 4: Add a recovery E2E**

Configure the hook to fail only the first partial commit through all five attempts, then delegate to `fs.promises.rename`. Assert:

- translation finishes successfully;
- the old subtitle was never truncated during the failed partial save;
- the final output contains the newest translated cues;
- checkpoint artifacts are removed on success.

- [ ] **Step 5: Rebuild and verify GREEN**

Run the Step 2 commands. Expected: both forced-failure and recovery E2E tests pass.

- [ ] **Step 6: Commit**

```powershell
git add electron/main/index.ts e2e/example.spec.ts
git commit -m "test: cover atomic subtitle output lifecycle"
```

### Task 6: Full Regression Verification

**Files:**
- No production changes expected.

**Interfaces:**
- Verifies the new writer against all prior translation, checkpoint, encoding, SSA, RPM, sponsorship, lifecycle, and analysis behavior.

- [ ] **Step 1: Run TypeScript checks**

```powershell
& .\node_modules\.bin\tsc.cmd --noEmit
& .\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
```

- [ ] **Step 2: Run all Node tests**

```powershell
corepack pnpm test
```

Expected: zero failures.

- [ ] **Step 3: Build the Electron test application**

```powershell
& .\node_modules\.bin\vite.cmd build --mode=test
```

- [ ] **Step 4: Run all Electron E2E**

```powershell
& .\node_modules\.bin\playwright.cmd test
```

Expected: all runnable tests pass; the packaged Windows conditional test may remain skipped.

- [ ] **Step 5: Inspect repository scope**

```powershell
git diff --check
git status --short
git log --oneline -12
```

Confirm that no output artifacts are staged and `e2e/screenshots/example.png` is the only expected uncommitted file.
