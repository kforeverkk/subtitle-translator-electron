# SSA to ASS Style Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert SSA input to standards-compliant bilingual ASS output without losing source styles or effects, and surface precise localized conversion errors before API translation begins.

**Architecture:** Keep the existing ASS, SRT, and VTT output paths unchanged. Store the original SSA source text with the parsed subtitle/checkpoint, then route only SSA-to-ASS output through a focused lossless converter that rewrites Script Info, V4 Styles, and Events while copying unknown sections and attachment payloads verbatim. Use a shared structured error payload so the Electron main process can report exact conversion failures and the renderer can localize them.

**Tech Stack:** TypeScript, Node.js, Electron IPC, ass-parser/ass-stringify for existing paths, Lingui, Node test runner, Playwright Electron E2E.

## Global Constraints

- Do not change ASS, SRT, or VTT output behavior except for shared error plumbing covered by tests.
- Do not add a new runtime dependency.
- Do not silently replace an incompatible SSA style with the default Arial ASS style.
- A conversion error must identify `SSA to ASS format conversion`, the affected section/style/field, preservation of the original/checkpoint, and a next action.
- A conversion failure must be detected before any OpenAI-compatible API request is sent.
- Unknown sections, comments, `[Fonts]`, and `[Graphics]` payload lines must survive unchanged.
- Existing v1/v2/v3 checkpoints remain readable; a standalone legacy SSA checkpoint without raw source must fail clearly instead of producing lossy ASS.
- Existing output naming, language isolation, atomic writes, RPM limiting, task cleanup, and successful-checkpoint deletion remain unchanged.

---

### Task 1: Structured SSA conversion errors and localized renderer messages

**Files:**
- Create: `electron/shared/ssa-to-ass-error.ts`
- Modify: `electron/shared/translation-error-codes.ts`
- Create: `src/utils/translation-error.ts`
- Modify: `src/components/TranslatorPanel.tsx`
- Modify: `src/i18n-messages.ts`
- Modify: `src/locales/en-US.po`
- Modify: `src/locales/zh-CN.po`
- Modify: `src/locales/zh-TW.po`
- Create: `tests/translation-error.test.mts`
- Modify: `package.json`

**Interfaces:**
- Produces: `createSsaToAssConversionError(details): Error`
- Produces: `parseSsaToAssConversionError(message): SsaToAssConversionErrorDetails | undefined`
- Produces: `getLocalizedTranslationError(error, fallbackId, t): string`

- [ ] **Step 1: Write failing shared protocol and localization tests**

Test round-tripping a payload such as `{ reason: "invalid-field", location: "style Sign.Alignment", value: "12" }`, rejection of malformed payloads, exact localization of ordinary existing error codes, and a Simplified Chinese conversion message containing `SSA 转 ASS 格式转换失败`, `style Sign.Alignment`, `12`, `未覆盖`, and an actionable suggestion.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/translation-error.test.mts`

Expected: FAIL because the shared protocol and renderer helper do not exist.

- [ ] **Step 3: Implement the structured protocol and localization helper**

Use a stable prefix plus URI-encoded JSON:

```ts
export type SsaToAssConversionReason =
  | "missing-source"
  | "missing-section"
  | "missing-format"
  | "invalid-field"
  | "missing-style"
  | "invalid-output";

export interface SsaToAssConversionErrorDetails {
  reason: SsaToAssConversionReason;
  location: string;
  value?: string;
}
```

The renderer helper must parse this payload before the exact-code lookup and format the outer localized message with a localized reason. Keep `getLocalizedError` call sites unchanged by replacing the local implementation with the imported helper.

- [ ] **Step 4: Add and compile all three locale messages**

Run: `pnpm run i18n:compile`

Expected: PASS with generated catalogs accepting all new message IDs.

- [ ] **Step 5: Run focused tests and type checking**

Run: `pnpm run typecheck`

Run: focused Node test from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```text
git add electron/shared src/components/TranslatorPanel.tsx src/utils/translation-error.ts src/i18n-messages.ts src/locales tests/translation-error.test.mts package.json
git commit -m "feat: report SSA conversion errors clearly"
```

### Task 2: Lossless SSA v4 to ASS v4+ structural converter

**Files:**
- Create: `electron/main/utils/ssa-to-ass.ts`
- Modify: `electron/main/utils/ass-bilingual.ts`
- Create: `tests/ssa-to-ass.test.mts`
- Create: `tests/fixtures/ssa/styled-effects.ssa`
- Create: `tests/fixtures/ssa/attachments.ssa`
- Modify: `package.json`

**Interfaces:**
- Consumes: `addAssBilingualStyles(full, fonts)` and `formatAssBilingualStyledText(...)`
- Produces: `convertSsaToBilingualAss(options): string`
- Produces: `validateSsaToAssSource(sourceText): void`

- [ ] **Step 1: Write failing conversion tests with representative SSA fixtures**

The styled fixture must contain at least two styles, all legal SSA alignments, decimal and hexadecimal colours, non-zero `AlphaLevel`, `Marked=0`, commas in dialogue text, `Banner`/`Scroll up` effects, and inline tags for position, movement, fade, karaoke, drawing, italics, and colour. Assert the output contains `ScriptType: v4.00+`, `[V4+ Styles]`, ASS style/event Format lines, converted alignment/alpha/outline fields, `Layer: 0`, derived bilingual styles, and byte-identical Text/Effect fragments apart from the intentional bilingual text wrapper.

The attachment fixture must contain comments, unknown metadata, `[Fonts]`, and `[Graphics]`; assert every payload line remains exactly present and no `: ` suffix is introduced.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/ssa-to-ass.test.mts`

Expected: FAIL because `ssa-to-ass.ts` does not exist.

- [ ] **Step 3: Implement a raw-section parser**

Split source text into preamble plus `{ header, name, lines }` sections without interpreting unknown lines. Recognize known section and descriptor names case-insensitively while retaining all untouched lines. Implement a bounded `splitFields(value, fieldCount)` that consumes only the first `fieldCount - 1` commas so dialogue Text may contain commas.

- [ ] **Step 4: Implement style conversion with strict validation**

Map SSA records by their declared Format names, require every rendering-critical field, and generate the standard ASS V4+ format:

```ts
const ASS_STYLE_FORMAT = [
  "Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour",
  "OutlineColour", "BackColour", "Bold", "Italic", "Underline",
  "StrikeOut", "ScaleX", "ScaleY", "Spacing", "Angle", "BorderStyle",
  "Outline", "Shadow", "Alignment", "MarginL", "MarginR", "MarginV",
  "Encoding",
];
```

Map alignments `1→1`, `2→2`, `3→3`, `5→7`, `6→8`, `7→9`, `9→4`, `10→5`, `11→6`. Convert signed decimal or `&H` BGR colours to `&HAABBGGRR`; apply `AlphaLevel` to primary, secondary, and outline, and use SSA/VSFilter shadow alpha semantics for BackColour. Throw the structured conversion error for invalid critical values.

- [ ] **Step 5: Reuse existing bilingual style generation**

Build a controlled V4+ style section, pass only that section through `addAssBilingualStyles`, and serialize only the controlled style records. Do not pass attachment or unknown sections through `ass-stringify`.

- [ ] **Step 6: Convert Events while preserving rendering content**

Require Text to be the final declared event field, map `Marked` to `Layer: 0`, retain Start/End/Style/Name/margins/Effect, and align Dialogue rows sequentially with translated cues. Preserve non-Dialogue and unknown raw lines. Apply `formatAssBilingualStyledText` only to Dialogue Text.

- [ ] **Step 7: Validate the generated ASS**

Parse the generated known Script Info, V4+ Styles, and Events sections, verify every Dialogue references a source or generated style and the Dialogue count equals the parsed cue count. Throw `invalid-output` instead of returning questionable text.

- [ ] **Step 8: Run focused tests and type checking**

Run: focused Node test from Step 2.

Run: `pnpm run typecheck`.

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```text
git add electron/main/utils/ssa-to-ass.ts electron/main/utils/ass-bilingual.ts tests/ssa-to-ass.test.mts tests/fixtures/ssa package.json
git commit -m "feat: preserve SSA styles in ASS output"
```

### Task 3: Translation, checkpoint, preflight, and atomic output integration

**Files:**
- Modify: `electron/main/utils/translate.ts`
- Modify: `electron/main/index.ts`
- Modify: `tests/translation-checkpoint.test.mts`
- Modify: `tests/subtitle-output-format.test.mts`
- Create: `tests/ssa-translation-integration.test.mts`
- Modify: `package.json`

**Interfaces:**
- Extends `AssSubtitle` with optional `source: { format: "ssa"; text: string }`
- Extends `saveTranslated(...)` with source-format-aware SSA routing without changing existing callers' output semantics
- Consumes: `validateSsaToAssSource` and `convertSsaToBilingualAss`

- [ ] **Step 1: Write failing checkpoint and integration tests**

Assert new SSA parses store raw source; v1/v2/v3 checkpoints without the optional field still parse; new v3 checkpoints round-trip it; SSA-to-ASS save uses the lossless converter; ASS/SRT/VTT saves remain byte-for-byte equal to pre-change fixtures. Assert standalone legacy SSA checkpoint plus ASS output throws `missing-source` clearly.

- [ ] **Step 2: Run the focused tests and verify failure**

Run the three affected Node test files directly with the project Node test flags.

Expected: FAIL because parsed SSA does not retain raw source and save routing is absent.

- [ ] **Step 3: Retain and validate raw SSA source in subtitle/checkpoint data**

On `parseSubtitle(fileContent, "ssa")`, attach `{ format: "ssa", text: fileContent }`. Update `isParsedSubtitle` to accept and validate the optional source object without rejecting old checkpoint documents. Do not increment checkpoint version because the field is additive and older readers ignore additional properties.

- [ ] **Step 4: Add conversion preflight before API use**

In each prepared translation task, when source format is SSA and output format begins with `ass-`, call `validateSsaToAssSource` before context analysis or translation requests. This must happen before the first request-rate-limiter slot and before output creation.

- [ ] **Step 5: Route SSA-to-ASS writes through the converter**

In `saveTranslated`, use the lossless converter only when the source is SSA and output is ASS. Keep existing atomic temporary-file/rename behavior. Do not catch and suppress the final conversion error; partial-write attempts may log it, but preflight ensures structural errors are already reported before translation.

- [ ] **Step 6: Preserve restart and resume behavior**

Verify clearing translated cues leaves the stored SSA source unchanged. Verify configuration restarts, successful completion cleanup, backup cleanup, output naming, and multiple target-language checkpoint isolation with SSA input.

- [ ] **Step 7: Run focused and complete Node checks**

Run: `pnpm run check`

Expected: all type checks and all Node tests PASS.

- [ ] **Step 8: Commit Task 3**

```text
git add electron/main/utils/translate.ts electron/main/index.ts tests package.json
git commit -m "fix: integrate safe SSA to ASS conversion"
```

### Task 4: Electron GUI success and failure coverage

**Files:**
- Modify: `e2e/example.spec.ts`
- Add fixtures under: `tests/fixtures/ssa/`

**Interfaces:**
- Consumes the real Electron `translateBatch` IPC and the existing local mock OpenAI-compatible server.
- Verifies main-to-renderer `batch-progress.error` localization through the real GUI.

- [ ] **Step 1: Add a successful real-GUI SSA translation test**

Launch the current worktree Electron build with its isolated test user-data directory, submit `styled-effects.ssa` to the mock server, choose `ass-bilingual`, wait for `done`, then read the generated ASS and verify source style fields, inline tags, Effect values, translated/original ordering, and absence of default-style fallback.

- [ ] **Step 2: Add a preflight failure GUI test**

Use an SSA fixture with alignment `12`. Assert the task reaches `error`, the visible details explicitly contain the localized SSA-to-ASS conversion category, style/field/value, preservation statement, and next action. Assert mock-server request count remains zero and no target ASS file exists.

- [ ] **Step 3: Run focused Electron E2E tests**

Run: `pnpm run e2e -- --grep "SSA"`

Expected: both SSA GUI cases PASS using the unpacked application built from this worktree, not an installed copy.

- [ ] **Step 4: Run the full Electron E2E suite**

Run: `pnpm run e2e`

Expected: all runnable tests PASS; only the existing packaged-executable test may skip when no external executable path is supplied.

- [ ] **Step 5: Commit Task 4**

```text
git add e2e/example.spec.ts tests/fixtures/ssa
git commit -m "test: cover SSA conversion in Electron"
```

### Task 5: Final regression, build, and review

**Files:**
- Modify only files required by failures directly caused by Tasks 1–4.

**Interfaces:**
- Produces a clean, locally committed worktree ready for user review; it does not push or publish a release.

- [ ] **Step 1: Run complete static and unit verification**

Run: `pnpm run check`

Expected: PASS with zero failures.

- [ ] **Step 2: Run complete Electron verification**

Run: `pnpm run e2e`

Expected: all runnable tests PASS.

- [ ] **Step 3: Build the application without publishing**

Run: `pnpm run build`

Expected: renderer, main process, and current-platform package build PASS; no GitHub release is created.

- [ ] **Step 4: Inspect the final diff and repository state**

Run: `git diff HEAD~4 --check`

Run: `git status --short --branch`

Expected: no whitespace errors and no uncommitted generated artifacts.

- [ ] **Step 5: Review regression boundaries**

Confirm from test output and diff that ASS input preservation, SRT output, checkpoint migration, account-wide RPM limiting, atomic writes, sponsor cadence, menu/window behavior, and release/version checks remain unchanged and passing.
