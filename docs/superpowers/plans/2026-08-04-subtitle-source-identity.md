# 原字幕双重身份校验实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用原始字节 SHA-256 与规范化字幕内容 SHA-256 可靠判断 checkpoint 是否属于当前原字幕，同时安全兼容历史 checkpoint。

**Architecture:** 新建独立的原字幕身份模块，负责稳定规范化、哈希生成和新旧 checkpoint 来源匹配；字幕文件由同一个 Buffer 完成解码、解析和身份计算。主进程只负责将一次读取所得的字幕快照与完整 fingerprint 传入现有 checkpoint、备份和翻译流程，不改变配置身份、任务 ID、原子写入和成功清理机制。

**Tech Stack:** TypeScript、Node.js `crypto`/`fs`、`subtitle`、`ass-parser`、Node test runner、Playwright Electron E2E、electron-builder。

## Global Constraints

- 新 checkpoint 同时写入 `rawHash`、`contentHash` 和 `contentHashVersion: 1`。
- `size` 与 `mtimeMs` 保持可读，但不得覆盖内容哈希判断。
- 哈希、解码和解析必须基于同一次文件读取。
- 内容身份排除 `translatedText`、编码、BOM 和换行符形式，保留原文、时间轴、顺序以及影响 ASS/SSA 输出的样式与特效。
- 可验证的 v1、v2、v3 checkpoint 允许续传并在下次写入时升级；无法验证时安全备份并从当前原字幕重启。
- 直接导入 checkpoint JSON 的恢复语义不变，不从 JSON 文件本身伪造原字幕 rawHash。
- 不改变输出命名、翻译配置 fingerprint、任务 ID、checkpoint 原子写入、备份归属和成功后清理。
- 不推送 GitHub；每个独立任务在本地 `main` 形成小提交。

---

## 文件结构

- Create: `electron/main/utils/subtitle-source-identity.ts`：稳定规范化、双哈希生成、新旧来源身份匹配。
- Create: `tests/subtitle-source-identity.test.mts`：各字幕格式的内容身份与双层判断单元测试。
- Modify: `electron/main/utils/subtitle-encoding.ts`：公开从同一 Buffer 解码的既有接口，不增加第二次文件读取。
- Modify: `electron/main/utils/translate.ts`：公开“从已解码文本解析”的入口，扩展 fingerprint 结构校验。
- Modify: `electron/main/utils/translation-checkpoint.ts`：扩展 fingerprint 类型，将来源匹配职责移交身份模块。
- Modify: `electron/main/index.ts`：普通字幕只读一次，并将解析快照和双哈希用于全部 checkpoint 查找及预览。
- Modify: `tests/translation-checkpoint.test.mts`：更新来源匹配测试并覆盖历史 checkpoint 升级。
- Modify: `tests/subtitle-encoding-integration.test.mts`：证明同一 Buffer 解码和解析链路保持兼容。
- Modify: `e2e/example.spec.ts`：真实 GUI 覆盖等价编码变化续传、同属性异内容拒绝续传和 ASS/SSA 样式变化。
- Modify: `package.json`：把新单元测试加入固定测试列表。

---

### Task 1: 规范化字幕内容并生成双哈希

**Files:**
- Create: `electron/main/utils/subtitle-source-identity.ts`
- Create: `tests/subtitle-source-identity.test.mts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ParsedSubtitle`、`SubtitleFileExtension`（从 `translate.ts` 仅作类型导入）。
- Produces: `SUBTITLE_CONTENT_HASH_VERSION`、`createSubtitleContentHash(parsed, format)`、`createSubtitleSourceFingerprint(buffer, parsed, format, metadata)`。

- [ ] **Step 1: 写入失败测试，固定规范化边界**

测试必须构造 SRT/VTT 数组节点和 ASS/SSA 解析结构，验证：

```ts
assert.equal(createSubtitleContentHash(withoutTranslation, "srt"),
  createSubtitleContentHash(withDifferentTranslatedText, "srt"));
assert.notEqual(createSubtitleContentHash(originalText, "srt"),
  createSubtitleContentHash(changedText, "srt"));
assert.notEqual(createSubtitleContentHash(originalTiming, "srt"),
  createSubtitleContentHash(changedTiming, "srt"));
assert.notEqual(createSubtitleContentHash(originalAssStyle, "ass"),
  createSubtitleContentHash(changedAssStyle, "ass"));
assert.equal(createSubtitleContentHash(originalAss, "ass"),
  createSubtitleContentHash(withPureCommentChange, "ass"));
```

并验证同一解析内容搭配不同原始 Buffer 时 `rawHash` 不同、`contentHash` 相同，结果包含 64 位小写十六进制哈希与 `contentHashVersion: 1`。

- [ ] **Step 2: 运行新测试并确认因模块不存在而失败**

Run: `pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-source-identity.test.mts`

Expected: FAIL，错误指向 `subtitle-source-identity.ts` 尚不存在或导出尚未定义。

- [ ] **Step 3: 实现稳定规范化和哈希生成**

在新模块中实现：

```ts
export const SUBTITLE_CONTENT_HASH_VERSION = 1;

export interface CompleteTranslationSourceFingerprint {
  size: number;
  mtimeMs: number;
  rawHash: string;
  contentHash: string;
  contentHashVersion: number;
}

export function createSubtitleContentHash(
  parsed: ParsedSubtitle,
  format: SubtitleFileExtension
): string;

export function createSubtitleSourceFingerprint(
  buffer: Uint8Array,
  parsed: ParsedSubtitle,
  format: SubtitleFileExtension,
  metadata: { size: number; mtimeMs: number }
): CompleteTranslationSourceFingerprint;
```

实现要求：

- 递归稳定排序对象键，数组顺序保持不变；
- 所有 cue 删除 `translatedText`，保留 `text`、`start`、`end` 和其他有效字段；
- ASS/SSA 以解析后的 `full` 为样式和头部身份主体，过滤明确的纯 Comment/注释记录，不使用原始 `source.text` 直接计算内容哈希；
- SRT/VTT 保留 cue 和有效 header，统一字符串中的 `\r\n`/`\r` 为 `\n`，只移除文件边界产生的无意义尾部换行，不折叠字幕文字内部空格；
- `rawHash` 直接对 Buffer 计算，`contentHash` 对带格式和算法版本的稳定 JSON 计算；
- 使用 `createHash("sha256")`，不新增依赖。

- [ ] **Step 4: 运行新单元测试并确认通过**

Run: `pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-source-identity.test.mts`

Expected: PASS。

- [ ] **Step 5: 将新测试加入固定测试命令并提交**

在 `package.json` 的 `test` 脚本中加入 `tests/subtitle-source-identity.test.mts`，然后运行 `pnpm run typecheck`。

Commit:

```text
feat: fingerprint subtitle source content
```

---

### Task 2: 扩展 checkpoint fingerprint 并实现新旧来源匹配

**Files:**
- Modify: `electron/main/utils/translation-checkpoint.ts`
- Modify: `electron/main/utils/translate.ts`
- Modify: `electron/main/utils/subtitle-source-identity.ts`
- Modify: `tests/translation-checkpoint.test.mts`
- Modify: `tests/subtitle-source-identity.test.mts`

**Interfaces:**
- Consumes: Task 1 的 `createSubtitleContentHash` 与 `SUBTITLE_CONTENT_HASH_VERSION`。
- Produces: 扩展后的 `TranslationSourceFingerprint`、`isCompleteTranslationSourceFingerprint`、`hasMatchingCheckpointSource(checkpoint, current)`。

- [ ] **Step 1: 写入新版、等价内容及历史 checkpoint 的失败测试**

测试至少覆盖：

```ts
assert.equal(hasMatchingCheckpointSource(modernExact, current), true);
assert.equal(hasMatchingCheckpointSource(modernRawDifferentContentSame, current), true);
assert.equal(hasMatchingCheckpointSource(modernSameStatsContentDifferent, current), false);
assert.equal(hasMatchingCheckpointSource(legacySnapshotEquivalent, current), true);
assert.equal(hasMatchingCheckpointSource(legacySnapshotDifferent, current), false);
assert.equal(hasMatchingCheckpointSource(unknownHashVersionEquivalentSnapshot, current), true);
```

还要验证名称或格式不同始终拒绝，部分哈希字段、非法摘要和非法版本不能通过 `parseTranslationCache`。

- [ ] **Step 2: 运行定向测试并确认旧实现失败**

Run: `pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-source-identity.test.mts tests/translation-checkpoint.test.mts`

Expected: FAIL，证明现有大小/时间判断会误接纳同属性异内容，且 schema 尚不认识完整哈希。

- [ ] **Step 3: 扩展 fingerprint 类型与严格 schema 校验**

将类型扩展为：

```ts
export interface TranslationSourceFingerprint {
  size: number;
  mtimeMs: number;
  rawHash?: string;
  contentHash?: string;
  contentHashVersion?: number;
}
```

校验规则：三个新字段必须同时存在或同时缺失；两个哈希必须匹配 `/^[a-f\d]{64}$/i`；版本必须为大于等于 1 的安全整数。未知版本保持文档可读，但不能直接用其 `contentHash` 与版本 1 比较。

- [ ] **Step 4: 实现来源匹配函数**

在身份模块中定义最小输入接口并实现：

```ts
export interface SubtitleSourceIdentityCheckpoint {
  format: SubtitleFileExtension;
  source: { name: string; fingerprint?: TranslationSourceFingerprint };
  subtitle: ParsedSubtitle;
}

export function hasMatchingCheckpointSource(
  checkpoint: SubtitleSourceIdentityCheckpoint,
  current: {
    sourceName: string;
    format: SubtitleFileExtension;
    fingerprint: TranslationSourceFingerprint;
  }
): boolean;
```

顺序为：先比名称和格式；完整且版本相同的 rawHash 相同立即通过；版本相同的 contentHash 相同通过；其余情况从 checkpoint 内嵌字幕快照按当前算法计算内容哈希，只有与当前 `contentHash` 相同才通过。任何规范化异常返回 false，不回退到大小/时间。

从 `translation-checkpoint.ts` 移除旧的大小/时间来源匹配实现，配置身份和任务身份函数保持不变。

- [ ] **Step 5: 运行定向测试和类型检查**

Run:

```text
pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-source-identity.test.mts tests/translation-checkpoint.test.mts
pnpm run typecheck
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

Commit:

```text
feat: verify checkpoint subtitle identity
```

---

### Task 3: 将普通字幕读取改为单 Buffer 快照

**Files:**
- Modify: `electron/main/utils/subtitle-encoding.ts`
- Modify: `electron/main/utils/translate.ts`
- Modify: `electron/main/index.ts`
- Modify: `tests/subtitle-encoding-integration.test.mts`
- Modify: `tests/translation-checkpoint.test.mts`

**Interfaces:**
- Consumes: Task 1 的 `createSubtitleSourceFingerprint`，Task 2 的 `hasMatchingCheckpointSource`。
- Produces: `parseSubtitleText(text, extension)`、`readSubtitleSourceSnapshot(filePath, extension, metadata)`，以及只基于快照的 `readTranslationInput`。

- [ ] **Step 1: 写入失败集成测试证明单次 Buffer 数据流**

通过依赖注入的读取函数统计读取次数，验证：

```ts
const snapshot = readSubtitleSourceSnapshot(path, "srt", metadata, {
  readFile: () => { reads += 1; return sourceBuffer; }
});
assert.equal(reads, 1);
assert.equal(snapshot.parsed[0].data.text, "当前原文");
assert.equal(snapshot.fingerprint.rawHash, sha256(sourceBuffer));
```

同时覆盖 GB18030 Buffer：解码文本正确、rawHash 对原字节计算、contentHash 与同内容 UTF-8 文件一致。

- [ ] **Step 2: 运行测试并确认新接口不存在而失败**

Run: `pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-encoding-integration.test.mts`

Expected: FAIL，指出 `readSubtitleSourceSnapshot` 尚未导出。

- [ ] **Step 3: 实现快照读取接口**

在 `translate.ts` 公开：

```ts
export function parseSubtitleText(
  text: string,
  fileExtension: SubtitleFileExtension
): ParsedSubtitle;

export function readSubtitleSourceSnapshot(
  filePath: string,
  extension: SubtitleFileExtension,
  metadata: { size: number; mtimeMs: number },
  options?: { readFile?: (path: string) => Buffer }
): {
  parsed: ParsedSubtitle;
  text: string;
  encoding: string;
  fingerprint: TranslationSourceFingerprint;
};
```

实现只调用一次 `readFile`，然后依次调用 `decodeSubtitleBuffer`、`parseSubtitleText` 和 `createSubtitleSourceFingerprint`。SSA 的 `source.text` 必须来自同一解码文本，不允许 `attachCurrentSsaSource` 再次读盘。

- [ ] **Step 4: 改造主进程普通字幕输入路径**

`readTranslationInput` 在确认扩展名后立即创建一次 source snapshot。将该 snapshot 的 `parsed` 与 `fingerprint` 用于：

- 精确 task checkpoint；
- 历史 checkpoint；
- 其他同配置 task checkpoint 查找；
- 不兼容 checkpoint 的干净重启；
- 无 checkpoint 的新任务；
- 字幕预览。

所有 `readMatchingCheckpoint` 调用改为传入 `{ sourceName, format, fingerprint }`。删除普通字幕路径中的重复 `parseSubtitleFile` 和 `attachCurrentSsaSource` 读盘；JSON checkpoint 读取维持严格 UTF-8 和现有独立恢复语义。

- [ ] **Step 5: 运行定向回归**

Run:

```text
pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/subtitle-encoding.test.mts tests/subtitle-encoding-integration.test.mts tests/subtitle-source-identity.test.mts tests/translation-checkpoint.test.mts tests/ssa-translation-integration.test.mts
pnpm run typecheck
```

Expected: 全部 PASS；`rg -n "parseSubtitleFile\(|readSubtitleFile\(" electron/main/index.ts` 不再显示普通字幕的二次读取。

- [ ] **Step 6: 提交**

Commit:

```text
fix: read subtitle identity from one snapshot
```

---

### Task 4: 固定 checkpoint 备份、升级与配置变化行为

**Files:**
- Modify: `tests/translation-checkpoint.test.mts`
- Modify: `electron/main/index.ts`
- Modify: `electron/main/utils/translate.ts`

**Interfaces:**
- Consumes: 完整 `TranslationSourceFingerprint` 和来源匹配函数。
- Produces: 新 checkpoint 自动升级、来源不匹配安全备份、配置变化仍干净重启。

- [ ] **Step 1: 写入端到端式 checkpoint 失败测试**

构造真实临时字幕和 checkpoint，覆盖：

- v1/v2/v3 内嵌原字幕与当前内容一致时恢复旧 translatedText；
- 恢复后新写入文档包含完整双哈希；
- 当前字幕内容不同但 size/mtime 被人工设置相同时，不恢复旧 translatedText；
- 来源不匹配时旧 checkpoint 在新 v3 原子写入成功前不移动；
- 原子写入失败时旧 checkpoint 保持原位；
- 来源相同但模型、语言、提示词或温度变化时，仍清除旧译文并备份。

- [ ] **Step 2: 运行 checkpoint 测试并确认失败场景**

Run: `pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/translation-checkpoint.test.mts`

Expected: 至少新写入升级或同属性异内容案例 FAIL。

- [ ] **Step 3: 最小化调整恢复元数据和写入数据流**

确保 `createTranslationCacheDocument` 总是接收当前普通字幕的完整 fingerprint。来源不匹配沿用 `shouldPreserveCheckpointSource` 和现有 pending source 机制，先写新 v3，再归档旧 checkpoint；配置不匹配继续由 `getTranslationCheckpointResumeMetadata` 控制 analysis 清除和干净重启。

不得在该任务重构 checkpoint 命名、备份清理或原子写入实现。

- [ ] **Step 4: 运行 checkpoint、输出和配置回归**

Run:

```text
pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/translation-checkpoint.test.mts tests/translation-output.test.mts tests/translation-success.test.mts tests/subtitle-preview.test.mts
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

Commit:

```text
fix: upgrade verified subtitle checkpoints
```

---

### Task 5: 添加真实 Electron GUI 回归

**Files:**
- Modify: `e2e/example.spec.ts`

**Interfaces:**
- Consumes: GUI 现有模拟 API、隔离用户数据目录、任务暂停/恢复和文件 fixture 工具。
- Produces: 双重身份校验的真实主进程—渲染进程回归覆盖。

- [ ] **Step 1: 写入三个 GUI 失败测试**

新增测试：

1. 中断 UTF-8 SRT 翻译，保持有效内容不变但转换为 GB18030 或改变换行符，重新添加后沿用已完成 cue，并只请求剩余 cue。
2. 中断 SRT 翻译，用同名、同字节长度且强制相同 mtime 的不同内容覆盖，重新添加后 API 收到全部新原文，输出中不存在旧译文。
3. 中断 ASS/SSA 翻译，仅改变有效样式或特效，重新添加后不得沿用旧 checkpoint；纯注释变化则允许续传。

每个测试必须断言 API 请求内容、请求次数、输出字幕、checkpoint/backup 状态和任务最终状态，不能只断言界面文字。

- [ ] **Step 2: 构建 E2E 应用并运行新测试，确认至少一项在旧逻辑下失败**

Run:

```text
$env:VITE_COMMIT_SHA=(git rev-parse --short HEAD)
pnpm run pree2e
pnpm exec playwright test e2e/example.spec.ts --grep "subtitle source identity"
```

Expected: 在实现完整接入前至少一项 FAIL；实现接入后全部 PASS。

- [ ] **Step 3: 如测试暴露边界问题，只修复来源身份数据流**

允许修改 `subtitle-source-identity.ts`、`translate.ts` 或 `index.ts`，但不得顺带修改 RPM、输出命名、赞助提示或窗口生命周期。

- [ ] **Step 4: 重跑新增 GUI 测试并提交**

Run: `pnpm exec playwright test e2e/example.spec.ts --grep "subtitle source identity"`

Expected: 全部 PASS。

Commit:

```text
test: cover subtitle source identity in Electron
```

---

### Task 6: 完整冲突与发布构建验证

**Files:**
- Verify only; only修复由本功能直接暴露的问题。

**Interfaces:**
- Consumes: Tasks 1–5 的完整实现。
- Produces: 可复核的单元、集成、GUI 和构建证据。

- [ ] **Step 1: 运行静态检查和全部固定测试**

Run: `pnpm run check`

Expected: TypeScript 检查通过，全部 Node 测试通过且无失败。

- [ ] **Step 2: 运行完整 Electron E2E**

Run:

```text
$env:VITE_COMMIT_SHA=(git rev-parse --short HEAD)
pnpm run pree2e
pnpm run e2e
```

Expected: 除必须显式提供安装包路径的条件测试外全部通过。重点复核编码识别、SSA 转 ASS、checkpoint、IPC pending、全局 RPM、菜单语言、About 生命周期、输出命名和每 20 次赞助提示。

- [ ] **Step 3: 构建 Windows 安装包和 unpacked 应用**

Run:

```text
$env:VITE_COMMIT_SHA=(git rev-parse --short HEAD)
pnpm run build
```

Expected: `release/win-unpacked/Subtitle Translator.exe` 和安装包生成成功；构建不得使用已安装的旧版程序。

- [ ] **Step 4: 使用精确新路径运行 packaged GUI 冒烟测试**

Run:

```text
$env:E2E_PACKAGED_EXECUTABLE=(Resolve-Path 'release/win-unpacked/Subtitle Translator.exe').Path
pnpm exec playwright test e2e/example.spec.ts --grep "packaged Windows GUI uses the current isolated build"
```

Expected: PASS，确认测试对象是本工作区当前构建，并使用隔离 userData。

- [ ] **Step 5: 检查改动范围和仓库状态**

Run:

```text
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: 无空白错误、无意外生成文件、工作区干净；本地 `main` 领先 origin，但没有推送。

- [ ] **Step 6: 若验证修复产生新提交，再重跑受影响测试后提交**

Commit（仅在需要时）：

```text
fix: harden subtitle source identity regressions
```

