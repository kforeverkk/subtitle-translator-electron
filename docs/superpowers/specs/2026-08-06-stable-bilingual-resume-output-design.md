# 双语续传输出文件名稳定性设计

## 目标

同一个翻译配置和输出格式的双语任务从 checkpoint 续传时，必须继续使用首次确定的输出文件名，不因语言检测结果波动或检测暂时失败而改名。

## 根因

双语输出文件名同时包含目标语言和模型检测到的原字幕语言，例如 `movie.en-zh.srt`。当前 checkpoint 只保存字幕、翻译配置指纹、任务标识和分析结果，没有保存首次语言检测及命名结果。

每次续传都会重新检测原字幕语言并重新调用输出路径生成逻辑。即使翻译配置完全相同，第二次检测也可能返回不同语言或失败回退为 `original`，使输出文件从 `movie.en-zh.srt` 变为 `movie.en-ja.srt` 或 `movie.en-original.srt`。

## checkpoint 数据

保持 checkpoint `version: 3`，增加可选的输出身份：

```ts
interface TranslationOutputIdentity {
  format: SubtitleOutputFormat;
  detectedSourceLanguage: string;
  fileName: string;
}

interface TranslationCacheDocument {
  // 现有字段保持不变
  output?: TranslationOutputIdentity;
}
```

`fileName` 只允许为单个文件名，不得包含目录、绝对路径、`.` 或 `..` 路径段。这样 checkpoint 不会绑定旧输出目录，也不能把续传写入 checkpoint 指定的任意位置。

## 首次翻译

1. 按现有流程检测原字幕语言。
2. 按目标语言、检测语言、输出格式和源字幕名生成输出文件名。
3. 把 `format`、`detectedSourceLanguage` 和生成后的 `fileName` 写入 checkpoint。
4. 输出目录仍由当前任务的 `outputDirectory` 决定；未指定时使用输入文件所在目录。

即使语言检测失败，也要保存最终采用的空检测值及回退生成的文件名，保证后续续传不会在检测恢复后再次改名。

## 匹配续传

同时满足以下条件时复用 checkpoint 输出身份：

- 源字幕身份校验通过；
- 翻译配置指纹完全一致；
- checkpoint 输出身份合法；
- 当前 `outputFormat` 与 checkpoint 的 `format` 相同。

续传时不再调用语言检测，直接把当前输出目录与 checkpoint 中的 `fileName` 组合成输出路径。

如果用户只更改输出目录，文件名保持不变，但输出写入新目录。

## 重新开始及格式变化

以下情况不复用旧输出身份：

- 模型、目标语言、提示词、附加提示、温度、API 地址或上下文大小发生变化，触发现有的重新翻译流程；
- 用户更改输出格式，例如从 `srt-bilingual` 改为 `ass-bilingual`；
- checkpoint 输出身份缺失、格式不合法或文件名不安全。

这些情况下重新检测语言并生成适合当前任务的新文件名。配置变化时，现有清空旧译文、备份不兼容 checkpoint 和重新开始机制保持不变。

## 旧 checkpoint 兼容

旧版 v1、v2、v3 checkpoint 没有 `output` 字段时继续可读：

1. 按现有兼容规则决定续传或重新开始。
2. 执行一次语言检测并生成输出文件名。
3. 下一次 checkpoint 原子写入时补全 `output` 字段。
4. 此后相同任务再次续传时复用该输出身份。

不修改旧 checkpoint 的来源校验、任务迁移和备份所有权规则。

## 安全与冲突处理

- 解析 checkpoint 时严格校验 `output.format`、语言字符串和文件名。
- 不信任 checkpoint 中的目录信息，也不接受目录信息。
- 最终路径继续进入现有 `claimTranslationPaths` 冲突检测，避免并行任务写入同一文件。
- 仅译文任务也可以保存输出身份以保持数据结构一致，但本次必须保证双语续传稳定；现有防覆盖命名规则保持不变。

## 测试

### 单元测试

- 新 checkpoint 可以保存并解析合法输出身份。
- 旧 checkpoint 缺少 `output` 时仍可解析。
- 拒绝带路径分隔符、绝对路径、`.`、`..` 或错误扩展名的文件名。
- 相同输出格式可复用已保存文件名。
- 输出格式变化时不复用旧文件名。
- 更换输出目录只改变目录，不改变文件名。

### Electron E2E

1. 启动双语翻译，首次检测返回 `Chinese`，中途失败并留下 checkpoint 与 `movie.en-zh.srt`。
2. 重新启动应用并续传，让 mock 语言检测返回不同结果或直接失败。
3. 验证续传没有再次请求语言检测，并继续写入 `movie.en-zh.srt`。
4. 验证没有生成 `movie.en-ja.srt` 或 `movie.en-original.srt`。
5. 使用旧 checkpoint 续传，验证只检测一次并在 checkpoint 中补全输出身份。

## 非目标

- 不删除用户目录中以前生成的其他语言字幕。
- 不改变字幕内容的 checkpoint 兼容判断。
- 不把输出目录加入翻译配置指纹。
- 不改变现有双语文件名的语言顺序。
