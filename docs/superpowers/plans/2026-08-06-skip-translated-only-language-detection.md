# 仅译文跳过源语言检测实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让仅译文任务直接按目标语言生成输出身份，不再消耗源语言检测 API 请求，同时保持双语命名和 checkpoint 兼容。

**架构：** 复用现有 `isBilingualOutput` 判断，在主进程创建新输出身份时只为双语格式运行 `detectSubtitleLanguage`。不新增 checkpoint 字段，不改变输出路径工具和翻译流水线。

**技术栈：** TypeScript、Electron IPC、Playwright Electron E2E。

## 全局限制

- 只跳过 `srt-translation` 的源语言检测。
- 所有双语输出格式继续检测原语言。
- 不改变同语言字幕的翻译行为。
- 不改变 checkpoint、输出命名、防覆盖、并发和 RPM 数据结构。
- 不推送或发布。
- 永久忽略 `e2e/screenshots/example.png` 自动截图差异。

---

### 任务一：用真实 API 请求计数建立 RED

**文件：**
- 修改：`e2e/example.spec.ts`

**接口：**
- 运行真实：`window.electronAPI.translateBatch`
- 观察真实：mock HTTP 服务器收到的请求

- [ ] **步骤 1：修改单任务请求计数预期**

把仅译文单任务从两次请求改为一次，并记录请求体：

```ts
expect(requestBodies).toHaveLength(1);
expect(isLanguageDetectionRequest(requestBodies[0])).toBe(false);
```

- [ ] **步骤 2：修改并行任务请求计数预期**

两个仅译文任务总请求数从四次改为两次，并继续验证两次请求之间遵守共享 RPM 最小间隔。

- [ ] **步骤 3：运行定向 E2E 并确认 RED**

```powershell
.\node_modules\.bin\vite.cmd build --mode=test
.\node_modules\.bin\playwright.cmd test e2e/example.spec.ts --grep "API count|share one RPM"
```

预期：当前代码仍执行语言检测，因此请求计数断言失败。

### 任务二：仅为双语输出检测源语言

**文件：**
- 修改：`electron/main/index.ts`

**接口：**
- 使用：`isBilingualOutput(outputFormat)`
- 保持：`createTranslationOutputIdentity(...)`

- [ ] **步骤 1：导入现有双语判断**

从 `subtitle-output.ts` 导入 `isBilingualOutput`，避免重复维护输出格式清单。

- [ ] **步骤 2：限制检测分支**

当没有可复用输出身份时：

```ts
let detectedSourceLanguage = "";
if (isBilingualOutput(params.outputFormat)) {
  detectedSourceLanguage = await detectSourceLanguageWithExistingFallback();
}
outputIdentity = createTranslationOutputIdentity(...);
```

保留当前重试、取消信号和检测失败回退；只改变它们是否在仅译文任务中运行。

- [ ] **步骤 3：运行定向 E2E 并确认 GREEN**

运行任务一的命令，预期两个测试通过。

### 任务三：完整回归与提交

**文件：**
- 不预期再修改生产代码

**接口：**
- 验证全部单元测试、构建和 Electron GUI

- [ ] **步骤 1：运行类型检查和全部单元测试**

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test <package.json 中全部测试>
```

预期：零失败。

- [ ] **步骤 2：运行完整 Electron E2E**

```powershell
.\node_modules\.bin\vite.cmd build --mode=test
.\node_modules\.bin\playwright.cmd test
```

预期：全部可运行测试通过；未提供独立 Windows 安装包时对应条件测试保持跳过。

- [ ] **步骤 3：检查差异并提交**

```powershell
git diff --check
git status --short
```

只提交本次代码、测试和中文文档，提交信息：

```text
fix: skip source detection for translated-only output
```
