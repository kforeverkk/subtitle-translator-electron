# 关闭主窗口时停止翻译实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 关闭主窗口或退出应用时取消全部活动翻译，保留最后可靠 checkpoint，并保证已销毁窗口不会使翻译流程因进度发送而异常。

**架构：** 将活动 `AbortController` 管理和安全事件发送提取为可独立测试的主进程工具。主窗口关闭与应用退出只负责发出全局取消信号，现有翻译流程继续负责等待在途处理、保存 checkpoint 和释放路径/RPM 资源。

**技术栈：** TypeScript、Node.js 内置测试框架、Electron IPC、Playwright Electron E2E。

## 全局限制

- 直接在用户已授权修改的现有 `main` 分支上工作，不推送或发布。
- 关闭主窗口后不得继续新的 API 请求、重试或字幕写入。
- 关闭导致的取消不得显示失败、完成或赞助提示。
- 不修改 checkpoint 数据格式和现有续传兼容规则。
- 不提前清空活动控制器注册表或释放路径保护。
- 永久忽略 `e2e/screenshots/example.png` 自动截图差异。

---

### 任务一：活动任务生命周期工具

**文件：**
- 新建：`electron/main/utils/translation-lifecycle.ts`
- 新建：`tests/translation-lifecycle.test.mts`
- 修改：`package.json`

**接口：**
- 产生：`TranslationControllerRegistry`
- 产生：`sendWebContentsMessageSafely(sender, channel, payload)`

- [ ] **步骤 1：先写失败测试**

覆盖以下真实行为：

```ts
const registry = new TranslationControllerRegistry();
const first = new AbortController();
const second = new AbortController();
registry.register("task-a", first);
registry.register("task-b", second);

registry.cancelAll();

assert.equal(first.signal.aborted, true);
assert.equal(second.signal.aborted, true);
assert.equal(registry.has("task-a"), true);
```

并验证已销毁发送目标和会抛错的发送目标都返回 `false`，不会抛出异常。

- [ ] **步骤 2：运行测试并确认 RED**

```powershell
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/translation-lifecycle.test.mts
```

预期：因为生命周期工具尚不存在而失败。

- [ ] **步骤 3：实现最小工具**

注册表内部使用 `Map<string, Set<AbortController>>`。`cancelAll()` 对当前集合的快照调用 `abort()`，但不清空映射；注销函数负责在任务 `finally` 中移除控制器。

安全发送接口只依赖 `isDestroyed()` 和 `send()`，便于使用真实 `WebContents` 及轻量测试替身。目标销毁或 `send()` 抛错时返回 `false`。

- [ ] **步骤 4：运行测试并确认 GREEN**

运行步骤 2 的命令，预期全部通过。

### 任务二：接入主窗口和翻译 IPC

**文件：**
- 修改：`electron/main/index.ts`
- 测试：`tests/translation-lifecycle.test.mts`

**接口：**
- 使用：`TranslationControllerRegistry`
- 使用：`sendWebContentsMessageSafely`

- [ ] **步骤 1：用注册表替换当前裸映射**

保持重复任务检查、单任务取消、注册及 `finally` 注销的现有顺序，只替换存储和调用入口。

- [ ] **步骤 2：接入主窗口关闭和应用退出**

在当前主窗口的 `close` 事件中调用 `cancelAll()`；在应用退出入口再次调用以覆盖非窗口触发的退出。重复调用不得产生额外状态。

- [ ] **步骤 3：保护所有进度发送**

让 `sendProgress` 调用安全发送工具。关闭竞态不得从 `sendProgress` 抛出异常；checkpoint 警告继续保留现有保护。

- [ ] **步骤 4：运行类型检查和生命周期单元测试**

```powershell
pnpm run typecheck
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/translation-lifecycle.test.mts
```

预期：全部通过。

### 任务三：真实 Electron 关窗续传回归

**文件：**
- 修改：`e2e/example.spec.ts`

**接口：**
- 运行真实：`window.electronAPI.translateBatch`
- 运行真实：窗口 `close`、HTTP AbortSignal、checkpoint 原子写入和续传

- [ ] **步骤 1：扩展 mock API 的连接关闭观察能力**

测试服务器记录延迟翻译响应是否在 `response.end()` 之前因客户端取消而关闭。只观察连接结果，不替代 Electron 或网络请求实现。

- [ ] **步骤 2：写关窗失败测试**

启动一条字幕翻译，等待延迟的流请求与初始 checkpoint，关闭主窗口并断言：

```ts
expect(abortedTranslationResponses).toBe(1);
expect(existsSync(checkpointPath)).toBe(true);
expect(existsSync(outputPath)).toBe(false);
```

然后重新激活窗口，以同一任务和配置续传，验证输出完成且 checkpoint 被成功清理。

- [ ] **步骤 3：运行新 E2E 并确认修复前会失败**

```powershell
pnpm run pree2e
pnpm exec playwright test e2e/example.spec.ts --grep "closing the main window"
```

预期：当前实现没有取消全部活动控制器，延迟翻译连接不会被主动中止。

- [ ] **步骤 4：完成必要接入并确认 GREEN**

再次运行步骤 3 的 E2E，预期通过。

### 任务四：完整回归验证

**文件：**
- 不预期再修改生产代码

**接口：**
- 验证全部既有核心功能和 GUI 回归

- [ ] **步骤 1：运行完整检查**

```powershell
pnpm run check
```

预期：类型检查和全部单元测试零失败。

- [ ] **步骤 2：运行完整 Electron E2E**

```powershell
pnpm run e2e
```

预期：全部可运行测试通过；缺少独立 Windows 安装包时，其条件测试可以保持跳过。

- [ ] **步骤 3：检查最终差异**

```powershell
git diff --check
git status --short
```

确认只包含本次生命周期修复、测试和中文文档；`e2e/screenshots/example.png` 继续不提交、不汇报。

- [ ] **步骤 4：提交本次修复**

只提交本次相关文件，提交信息：

```text
fix: stop translations when the main window closes
```
