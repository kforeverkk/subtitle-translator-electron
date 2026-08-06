# shadcn 开发依赖分类设计

## 目标

保留项目现有的 shadcn 组件开发能力和构建期样式，同时避免把 shadcn 命令行工具及其依赖树视为安装后软件所需的生产依赖。

## 当前用途

项目中的 shadcn 有两类用途：

1. 开发人员使用 `pnpm exec shadcn add ...` 增删组件。
2. `src/index.css` 在 Vite/Tailwind 构建期间导入 `shadcn/tailwind.css`。

组件运行代码已经复制在 `src/components/ui` 中。安装后的 Electron 应用加载构建完成的 `dist` 和 `dist-electron`，不会执行 shadcn CLI，也不会在运行时解析 `shadcn/tailwind.css`。

## 修改

把 `shadcn` 从 `package.json.dependencies` 移动到 `package.json.devDependencies`，版本约束保持 `^4.13.0`。

同步调整 `pnpm-lock.yaml` 根 importer：

- 从 `dependencies.shadcn` 删除；
- 在 `devDependencies.shadcn` 添加相同 specifier 和解析版本；
- 不改动 shadcn 或其传递依赖的锁定版本。

## 构建与开发行为

- 普通 `pnpm install` 会继续安装开发依赖，shadcn CLI 可用。
- GitHub Actions 当前执行 `pnpm install --frozen-lockfile`，构建阶段可正常解析 `shadcn/tailwind.css`。
- Vite 会把该 CSS 编译进 `dist`，安装后的软件无需 shadcn 包。
- 未来仍可运行：

```text
pnpm exec shadcn add <component>
```

- 只安装生产依赖的环境不能直接构建项目，但当前 Vite、TypeScript、Tailwind 和 Electron Builder 本来就属于开发依赖，因此本次不新增这一限制。

## 预期收益

- 生产依赖审计不再把 shadcn CLI 的 Babel、MCP SDK、ts-morph、命令行交互等依赖计入运行时依赖树。
- Electron Builder 可以排除只属于开发期的 shadcn 依赖闭包。
- 安装包与 `app.asar` 有机会明显缩小，实际幅度必须通过重新打包测量。
- 减少安全审计噪音，使真正的运行时依赖问题更容易识别。

shadcn 包自身约为0.77 MiB，但主要体积来自其传递依赖，不能仅以直接包大小估算最终收益。

## 风险与限制

- 如果构建工具没有正确打包 `shadcn/tailwind.css`，界面样式可能缺失；必须通过生产构建和 Electron E2E 验证。
- 锁文件分类错误会导致 `--frozen-lockfile` 安装失败；必须核对根 importer。
- 不删除 shadcn，不复制其 CSS 到项目内，也不改变现有组件源码。
- 不修改其他依赖的生产/开发分类。

## 验证

修改前基线：

- Windows `app.asar`：114,738,737 bytes（109.42 MiB）。
- Windows 2.1.3 安装包：113,345,413 bytes（108.09 MiB）。

修改后验证：

1. `shadcn --help` 可以运行。
2. Vite 测试构建可以解析 `shadcn/tailwind.css`。
3. TypeScript 和全部单元测试通过。
4. Electron E2E 全部可运行测试通过，确认界面样式与交互仍存在。
5. Electron Builder 重新生成 Windows unpacked 目录，比较 `app.asar`。
6. 核对最终锁文件和 Git 差异。

## 非目标

- 不升级 shadcn 版本。
- 不删除或重写现有 shadcn 组件。
- 不复制 `shadcn/tailwind.css` 到源码。
- 不在本次修改中处理其他安全公告。
