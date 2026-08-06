# shadcn 开发依赖分类实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 将 shadcn 保留为开发和构建工具，同时从安装后软件的生产依赖树中移除。

**架构：** 只修改 `package.json` 与 `pnpm-lock.yaml` 的根依赖分类，不改变版本、组件源码或CSS导入。以CLI、Vite、全量测试和实际Electron打包产物验证分类安全。

**技术栈：** pnpm lockfile v9、Vite、Tailwind CSS、Electron Builder、Playwright Electron E2E。

## 全局限制

- shadcn版本保持 `^4.13.0`。
- 保留 `src/index.css` 中的 `@import "shadcn/tailwind.css"`。
- 不修改其他依赖分类。
- 不推送或发布。
- 永久忽略 `e2e/screenshots/example.png` 自动截图差异。
- 修改前 `app.asar` 基线为114,738,737 bytes。

---

### 任务一：移动依赖分类

**文件：**
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`

**接口：**
- 保留：`pnpm exec shadcn`
- 保留：Vite 对 `shadcn/tailwind.css` 的解析

- [ ] **步骤 1：修改 package.json**

从 `dependencies` 删除：

```json
"shadcn": "^4.13.0"
```

并在 `devDependencies` 按字母顺序添加相同条目。

- [ ] **步骤 2：同步 lockfile 根 importer**

把相同 specifier 和解析版本从 `importers["."].dependencies` 移到 `devDependencies`，不改 snapshots 和 packages 中的锁定数据。

- [ ] **步骤 3：检查锁文件结构**

确认根 importer 只有一个 shadcn 条目，并位于 `devDependencies`。

### 任务二：验证开发和构建能力

**文件：**
- 不预期修改源码

**接口：**
- 运行：本地 shadcn CLI
- 构建：Vite/Tailwind CSS

- [ ] **步骤 1：验证 shadcn CLI**

```powershell
.\node_modules\.bin\shadcn.cmd --help
```

预期：退出码0并显示命令帮助。

- [ ] **步骤 2：运行类型检查和全部单元测试**

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\tsc.cmd -p tsconfig.node.json --noEmit
node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test <package.json中的全部测试>
```

- [ ] **步骤 3：构建测试应用并运行Electron E2E**

```powershell
.\node_modules\.bin\vite.cmd build --mode=test
.\node_modules\.bin\playwright.cmd test
```

预期：CSS构建成功，全部可运行GUI测试通过。

### 任务三：验证打包体积

**文件：**
- 生成但不提交：`release/win-unpacked`

**接口：**
- 运行：Electron Builder Windows directory target

- [ ] **步骤 1：重新生成Windows unpacked目录**

```powershell
.\node_modules\.bin\electron-builder.cmd --win --dir --publish never
```

- [ ] **步骤 2：记录新 app.asar**

读取 `release/win-unpacked/resources/app.asar` 字节数，与114,738,737 bytes基线比较。

- [ ] **步骤 3：检查生产包内容**

确认软件仍可打包，且产物未因缺少CSS或模块失败。

### 任务四：最终复核与提交

**文件：**
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`

**接口：**
- 确认只有依赖分类发生变化

- [ ] **步骤 1：检查差异**

```powershell
git diff --check
git status --short
```

- [ ] **步骤 2：提交**

只提交本次依赖分类、中文设计和计划，提交信息：

```text
build: move shadcn to development dependencies
```
