# 翻译失败时保留真实进度实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 部分字幕翻译成功后发生错误时，错误事件继续显示真实完成进度、已完成条数和总条数。

**架构：** 将每文件的进度计数提升到 `processFile` 的 `try/catch` 共享作用域。错误路径直接使用主进程已经维护的完成数量，不增加磁盘读取或界面补偿逻辑。

**技术栈：** TypeScript、Electron IPC、Playwright Electron E2E。

## 全局限制

- 不改变checkpoint数据结构或写入顺序。
- 不改变翻译重试、批次大小、并发和RPM机制。
- 输入解析前失败仍显示0%。
- 部分完成后失败必须显示真实比例。
- 不修改整批IPC参数校验失败路径。
- 不推送或发布。
- 永久忽略 `e2e/screenshots/example.png` 自动截图差异。

---

### 任务一：真实部分失败回归测试

**文件：**
- 修改：`e2e/example.spec.ts`

**接口：**
- 运行：真实 `window.electronAPI.translateBatch`
- 观察：真实 `batch-progress` 错误事件和checkpoint文件

- [ ] **步骤 1：建立60条字幕测试数据**

生成60条SRT字幕，输出格式选择 `srt-translation`，并发设为1。mock内容分析返回合法梗概和空术语表。

- [ ] **步骤 2：让第一批成功、第二批失败**

流请求第一次返回20条译文，之后三次返回空流，触发现有三次自动尝试后的错误。

- [ ] **步骤 3：断言真实失败进度**

```ts
expect(progress.status).toBe("error");
expect(progress.progress).toBeCloseTo(100 / 3);
expect(progress.currentCue).toBe(20);
expect(progress.totalCues).toBe(60);
```

同时读取checkpoint，验证恰好20条 cue 带有非空 `translatedText`。

- [ ] **步骤 4：运行定向E2E并确认RED**

```powershell
.\node_modules\.bin\vite.cmd build --mode=test
.\node_modules\.bin\playwright.cmd test e2e/example.spec.ts --grep "keeps partial progress"
```

预期：当前错误事件返回0%，测试失败。

### 任务二：错误事件使用真实计数

**文件：**
- 修改：`electron/main/index.ts`

**接口：**
- 产生：错误 `BatchProgress.progress/currentCue/totalCues`

- [ ] **步骤 1：提升计数变量作用域**

在文件处理 `try` 之前声明：

```ts
let totalCues = 0;
let completedCues = 0;
```

解析字幕及检查checkpoint后为其赋值，正常路径继续使用同一变量。

- [ ] **步骤 2：计算错误进度**

错误处理中先限制完成数量不超过总数，再按总数计算比例；总数未知或为0时保持0%。

- [ ] **步骤 3：补全错误事件字段**

当总数已知时发送 `currentCue` 和 `totalCues`，保留现有错误信息与输出路径。

- [ ] **步骤 4：运行定向E2E并确认GREEN**

运行任务一的命令，预期通过。

### 任务三：完整回归与提交

**文件：**
- 不预期再修改生产代码

**接口：**
- 验证类型、单元测试、测试构建和GUI行为

- [ ] **步骤 1：运行类型检查及全部单元测试**

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test <package.json中的全部测试>
```

- [ ] **步骤 2：运行完整Electron E2E**

```powershell
.\node_modules\.bin\vite.cmd build --mode=test
.\node_modules\.bin\playwright.cmd test
```

- [ ] **步骤 3：检查差异并提交**

```powershell
git diff --check
git status --short
```

只提交本次代码、测试和中文文档，提交信息：

```text
fix: preserve partial progress when translation fails
```
