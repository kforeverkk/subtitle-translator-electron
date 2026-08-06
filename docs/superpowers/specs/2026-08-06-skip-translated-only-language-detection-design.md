# 仅译文跳过源语言检测设计

## 目标

仅译文任务不再为了输出文件名额外调用源语言检测 API。双语任务继续检测原字幕语言，以生成包含原语言代码的文件名。

## 根因

当前主进程在没有可复用输出身份时，无论输出格式为何都会调用 `detectSubtitleLanguage`。但仅译文格式 `srt-translation` 的文件名只使用目标语言代码：

```text
movie.srt + English → movie.en.srt
```

检测出的 `Chinese`、`Japanese` 等原语言不会参与仅译文文件名，也不会用于跳过同语言翻译或改变翻译提示词。因此这次 API 请求没有实际消费者。

## 修改规则

- `srt-translation`：不调用源语言检测，直接以空的 `detectedSourceLanguage` 创建输出身份。
- `srt-bilingual`、`srt-original-translation`、`ass-bilingual`、`ass-original-translation`：继续调用源语言检测。
- 有合法且可复用的 checkpoint 输出身份时，继续直接复用，不额外检测。
- 输出格式从仅译文改为双语时，旧输出身份因格式不同而不可复用，必须重新检测原语言。
- 输出格式从双语改为仅译文时，直接按目标语言生成仅译文文件名，不检测原语言。

## checkpoint 兼容

checkpoint 数据结构保持不变。仅译文输出身份继续保存：

```ts
{
  format: "srt-translation",
  detectedSourceLanguage: "",
  fileName: "movie.en.srt"
}
```

旧 checkpoint 缺少输出身份时：

- 仅译文续传直接补全仅译文输出身份；
- 双语续传仍检测原语言后补全输出身份。

## 影响

- 每个新建仅译文任务通常减少一次 API 请求。
- 语言检测若遇到可重试错误时，最多三次的额外请求也一并消除。
- 减少 RPM、Token、延迟和少量费用。
- 不改变翻译请求、内容分析、重试、并发、RPM 限制和字幕写入。
- 不改变同语言字幕是否需要翻译的现有行为。

## 测试

- 一个新建仅译文任务只产生一条实际翻译请求，不产生语言检测请求。
- 两个并行仅译文任务总共只产生两条翻译请求，仍共享同一 API 账户的 RPM 限制。
- 仅译文输出仍为 `movie.en.srt`。
- 既有双语 E2E 继续验证语言检测及 `movie.en-zh.srt` 等文件名。
- checkpoint 迁移、格式变化、关窗取消和完整 GUI 回归继续通过。

## 非目标

- 不增加“源语言等于目标语言时跳过翻译”的功能。
- 不删除双语任务的源语言检测。
- 不调整语言代码表、文件名剥离规则或路径冲突规则。
