# 空流错误自动重试实施计划

> **供代理执行者使用：** 必须使用 `superpowers:executing-plans` 按任务执行，并使用 `superpowers:test-driven-development` 保证每项行为先出现预期失败、再实现通过。

**目标：** 当 AI SDK 抛出 `NoOutputGeneratedError` 时，仅对当前失败的翻译请求执行最多三次自动尝试，并消除界面中只有空白差异的重复错误消息。

**架构：** 将错误提取、可重试判断、`Retry-After` 读取和通用重试循环从 `electron/main/index.ts` 提取到独立工具模块。主进程仍负责真实翻译调用、RPM 限制、字幕批次、checkpoint 和进度状态；工具模块只决定是否及何时再次调用传入函数。

**技术栈：** TypeScript、Node.js 原生测试运行器、AI SDK 7、Electron、Playwright、pnpm。

## 全局约束

- 最多三次自动尝试包含首次请求，即最多额外重试两次。
- 每次尝试都重新调用现有翻译函数，因此仍经过现有按 API 地址和密钥划分的 RPM 限制器。
- 只重试当前失败的字幕批次，不清除已经完成并写入 checkpoint 的进度。
- HTTP 400、401、403、404、无效地址、格式/编码/checkpoint 错误及用户取消仍立即停止。
- 三次全部失败后抛出最后一次原始错误，由现有任务流程标记失败并保留有效 checkpoint。
- SSA 转 ASS 的结构化错误消息保持最高优先级。
- 所有文档与新增说明使用中文。
- 改动保留在本地 `main`，本轮不推送 GitHub。

---

### 任务 1：为错误分类、消息规范化和三次尝试建立单元测试

**文件：**
- 新建：`tests/translation-retry.test.mts`
- 修改：`package.json`
- 后续实现：`electron/main/utils/translation-retry.ts`

**接口：**
- 使用 `getErrorDetails(error: unknown)` 返回 `{ message: string; name?: string; status?: number }`。
- 使用 `isRetryableTranslationError(error: unknown): boolean`。
- 使用 `retryTranslation<TInput, TResult>(fn, input, options?): Promise<TResult>`。
- `options` 支持 `delayMs`、`abortSignal`、可注入的 `sleep`、`random` 和 `onRetry`，以便测试真实重试行为而无需等待。

- [ ] **步骤 1：先写会失败的测试**

  新测试使用 AI SDK 的真实 `NoOutputGeneratedError` 构造方式或其公开 `isInstance` 协议，覆盖：

  - 前两次空流、第三次成功时返回结果且调用三次；
  - 三次均为空流时抛出第三次错误且不出现第四次调用；
  - HTTP 401 只调用一次；
  - 已取消信号不开始调用，重试等待期间取消后不再调用；
  - `NoObjectGeneratedError`、429、5xx、网络超时仍可重试；
  - 外层与 `cause` 消息只有首尾、换行和连续空白差异时只显示一次；
  - 真正不同的两条消息仍按原顺序使用 ` | ` 拼接；
  - 结构化 SSA 转 ASS 错误仍原样优先返回。

- [ ] **步骤 2：将新测试加入固定测试脚本**

  在 `package.json` 的 `test` 命令中加入：

  ```text
  tests/translation-retry.test.mts
  ```

- [ ] **步骤 3：运行新测试并确认按预期失败**

  运行：

  ```powershell
  pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/translation-retry.test.mts
  ```

  预期：因 `electron/main/utils/translation-retry.ts` 尚不存在或缺少目标导出而失败；失败原因不能是测试语法、模块解析或夹具构造错误。

---

### 任务 2：实现独立重试工具并接入主进程

**文件：**
- 新建：`electron/main/utils/translation-retry.ts`
- 修改：`electron/main/index.ts`
- 测试：`tests/translation-retry.test.mts`

**接口：**
- `getErrorDetails(error)` 负责状态码、名称和规范化消息提取。
- `getRetryAfterMs(error)` 继续使用 `getRetryAfterMsFromHeaders`。
- `isRetryableTranslationError(error)` 新增识别 `NoOutputGeneratedError`，保留既有分类。
- `retryTranslation(fn, input, options)` 默认三次尝试、默认基础等待 1000ms，并在最终失败时原样抛出最后错误。

- [ ] **步骤 1：实现最小工具模块**

  模块导入：

  ```ts
  import {
    APICallError,
    NoObjectGeneratedError,
    NoOutputGeneratedError,
  } from "ai";
  import { setTimeout as sleep } from "node:timers/promises";
  import { translationErrorCodes } from "../../shared/translation-error-codes";
  import { parseSsaToAssConversionError } from "../../shared/ssa-to-ass-error";
  import { getRetryAfterMsFromHeaders } from "./retry-after";
  ```

  消息去重先对每条消息执行 `trim().replace(/\s+/g, " ")`，丢弃空字符串，再按规范化文本去重。结构化 SSA 错误在普通拼接前选出并直接返回。

  重试循环在每次调用前执行 `abortSignal?.throwIfAborted()`；捕获后若已取消、达到第三次或错误不可重试，则立即抛出。需要重试时按现有公式计算递增等待与随机抖动，并以 `Retry-After` 为下限。

- [ ] **步骤 2：运行单元测试并确认通过**

  运行任务 1 的单文件测试命令。

  预期：全部通过，无未处理 Promise 或警告。

- [ ] **步骤 3：让主进程使用新模块**

  从 `electron/main/index.ts` 删除 AI SDK 错误类、`sleep`、`getRetryAfterMsFromHeaders`、本地错误工具函数和本地三次重试循环，改为导入：

  ```ts
  import {
    getErrorMessage,
    retryTranslation,
  } from "./utils/translation-retry";
  ```

  将三个现有 `retryTranslate(...)` 调用改为 `retryTranslation(...)`，保持参数与行为一致。主进程不移动 RPM、checkpoint 或字幕写入代码。

- [ ] **步骤 4：运行类型检查与固定单元测试**

  运行：

  ```powershell
  pnpm run check
  ```

  预期：类型检查通过，全部 Node/TypeScript 测试通过。

---

### 任务 3：增加真实 Electron 空流回归测试

**文件：**
- 修改：`e2e/example.spec.ts`

**接口：**
- 扩展现有 `startMockOpenAiServer`，允许每个流式请求根据请求序号返回空 SSE、正常 SSE 或指定 HTTP 错误。
- 测试继续通过真实 `window.electronAPI.translateBatch()` 进入主进程，不直接调用工具模块。

- [ ] **步骤 1：先添加前两次空流、第三次成功的 E2E**

  创建一条字幕和隔离临时目录，模拟服务记录流请求次数：

  ```text
  第 1 次：结束流但不给出有效输出
  第 2 次：结束流但不给出有效输出
  第 3 次：返回合法 elements
  ```

  断言任务完成、流请求恰好三次、输出字幕包含第三次译文，且完成后 checkpoint 与备份均清理。

- [ ] **步骤 2：运行该 E2E 并确认修复前失败**

  运行：

  ```powershell
  pnpm run pree2e
  pnpm exec playwright test e2e/example.spec.ts --grep "空流"
  ```

  如果工具模块已经在任务 2 实现，则通过临时恢复旧的错误分类或先只运行主进程接入前版本证明测试会捕获“第一次空流即失败”；确认后恢复目标实现。不得把测试通过本身误当作红阶段。

- [ ] **步骤 3：补充三次失败与 401 的 E2E**

  - 三次空流：断言流请求恰好三次、任务失败、最后有效 checkpoint 仍存在。
  - HTTP 401：断言只发出一次流请求、任务立即失败。

- [ ] **步骤 4：运行空流相关 E2E 并确认全部通过**

  运行任务 3 步骤 2 的 grep 命令。

---

### 任务 4：完整回归、Windows 构建与打包版 GUI 隔离验证

**文件：**
- 验证现有全部项目文件
- 生成但不提交：`release/win-unpacked/Subtitle Translator.exe`

- [ ] **步骤 1：运行完整静态检查和 Node 测试**

  ```powershell
  pnpm run check
  ```

- [ ] **步骤 2：运行完整 Electron E2E**

  ```powershell
  pnpm run pree2e
  pnpm run e2e
  ```

  必须确认 checkpoint、字幕编码、SSA 转 ASS、并行 RPM、赞助提示、窗口生命周期及新增空流测试均通过。

- [ ] **步骤 3：生成当前工作区 Windows 构建**

  ```powershell
  pnpm run build
  ```

  必须确认 `release/win-unpacked/Subtitle Translator.exe` 为本次构建产物。

- [ ] **步骤 4：用精确 EXE 路径做隔离 GUI 验证**

  ```powershell
  $env:SUBTITLE_TRANSLATOR_PACKAGED_EXE = (Resolve-Path "release\win-unpacked\Subtitle Translator.exe").Path
  pnpm exec playwright test e2e/example.spec.ts --grep "packaged Windows GUI uses the current isolated build"
  Remove-Item Env:SUBTITLE_TRANSLATOR_PACKAGED_EXE
  ```

  E2E 必须断言运行时 exe 路径、应用版本和隔离 `userData`，以排除误启动电脑中已安装的旧版。

- [ ] **步骤 5：审查最终差异并提交到本地 main**

  ```powershell
  git diff --check
  git status --short
  git diff --stat
  ```

  只提交本次源代码、测试、计划与设计文档相关改动；不提交 `release`、测试报告或临时字幕文件。

