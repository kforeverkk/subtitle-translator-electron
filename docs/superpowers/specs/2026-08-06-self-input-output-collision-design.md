# 当前输入与输出同名保护设计

## 目标

仅修复一个翻译任务的最终输出路径与该任务当前输入字幕路径完全相同时，输出字幕覆盖原字幕的问题。

本次不处理跨任务输入保护，也不保护目录中未被选为当前输入的其他已有字幕。已有同名输出文件仍按现有规则直接覆盖。

## 命名规则

正常输出名称保持不变。只有计算后的输出路径与当前输入路径相同时才启用备用名称。

仅译文与双语模式使用相同的备用规则：保留当前输入文件的完整基本名，再追加本次生成的语言后缀。

```text
movie.en.srt + English
→ movie.en.en.srt

movie.translated.srt + unknown target
→ movie.translated.translated.srt
```

```text
movie.en-zh.srt + translate-original(en-zh)
→ movie.en-zh.en-zh.srt

movie.zh-en.srt + original-translate(zh-en)
→ movie.zh-en.zh-en.srt

movie.translated-original.srt + unknown translate-original
→ movie.translated-original.translated-original.srt

movie.original-translated.ass + unknown original-translate
→ movie.original-translated.original-translated.ass
```

输出目录与输入目录不同时，即使文件名相同也不属于当前输入路径覆盖，继续使用正常文件名并覆盖目标目录中已有的同名字幕。

## Checkpoint 续传

复用 checkpoint 输出身份后，必须使用最终输出目录重新检查实际输出路径。

如果 checkpoint 保存的输出文件名会指向当前输入文件，则不直接复用危险文件名，而是根据当前输出格式、目标语言和 checkpoint 保存的检测原语言生成上述统一备用名称。修正后的输出身份写回后续 checkpoint，保证续传文件名稳定。

不发生路径碰撞的 checkpoint 输出身份保持原样。例如旧 checkpoint 已安全使用 `movie.translated.en.srt` 时，续传不会强制迁移到 `movie.en.en.srt`，避免同一任务中途更换输出文件。

## 明确不在范围内

- 一个任务的输出与另一个任务的输入冲突。
- 多个任务争用同一个输出文件。
- 自动编号 `.2`、`.3`。
- 询问是否覆盖已有输出文件。
- 保护未被选为本次输入的目录内字幕。
- 修改输出目录选择逻辑。
- 修改语言检测、语言代码或字幕内容。

## 验证

- 覆盖 SRT/ASS 两种双语顺序和未知语言备用后缀。
- 验证正常输出仍直接覆盖已有同名译文。
- 验证危险 checkpoint 输出身份得到修正。
- 验证安全 checkpoint 输出身份保持不变。
- 真实 Electron 测试确认输入文件内容保持不变，新字幕写入追加后缀路径。
- 完整类型、单元、构建和 Electron E2E 回归。
