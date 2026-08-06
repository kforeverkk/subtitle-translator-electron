# 语言别名与文件后缀识别分离设计

## 背景

当前 `electron/main/utils/output-path.ts` 中的 `getLanguageCode()` 同时承担两种职责：

1. 将用户输入、模型返回值和语言别名转换为标准语言代码；
2. 判断输入字幕文件名末尾是否为程序生成的语言后缀，并在生成新名称前剥离该后缀。

第一种用途需要宽松兼容，例如接受 `English`、`英语`、`en-US`，以及 `in → id`、`iw → he` 等历史代码。第二种用途则应当保守，因为普通文件名的最后一段可能恰好与语言名称或历史代码相同。

例如，现有实现可能将 `Stay.in.srt` 中的 `in` 当作印度尼西亚语旧代码剥离，导致翻译成法语时生成 `Stay.fr.srt`，而不是保留标题内容并生成 `Stay.in.fr.srt`。

## 目标

- 保留宽松的语言输入和模型语言识别能力。
- 文件名剥离只承认程序真正会生成的标准语言代码。
- 保持现有标准单语、双语和旧版 `.translated.<code>` 输出的命名兼容性。
- 不改变输入文件保护、跨任务路径保护和 checkpoint 输出身份复用机制。
- 不尝试消除标准两字母代码自身固有的文件名歧义。

## 非目标

- 不改变当前支持的语言数量和标准输出代码。
- 不引入编号后缀、弹窗或新的输出目录策略。
- 不根据文件内容推测文件名末尾是否为语言。
- 不通过 checkpoint 追踪所有历史输出文件的来源。
- 不改变与活动输入无关的已有同名输出可以被覆盖的既定策略。

## 设计

### 1. 分离两种语言集合

保留宽松的语言别名映射，用于 `getLanguageCode()`：

- 英文语言名称；
- 本族语名称；
- 简体和繁体中文名称；
- 标准两字母代码及地区形式；
- 必要的历史代码，例如 `in → id`、`iw → he`。

新增独立的“程序生成语言代码”集合。它只包含程序实际用于字幕文件名的27个标准代码：

```text
en fr ja de es it pt ko zh ru ar
nl pl tr vi th id uk he cs sv da fi no el hu ro
```

该集合是文件名识别的唯一语言代码依据。语言名称、地区代码和历史代码不得进入此集合。

### 2. 文件名后缀判断

增加一个职责单一的判断函数，用来确认某一段是否为程序生成的标准语言代码。该判断：

- 接受大小写不同的标准代码；
- 只接受完整匹配；
- 不接受语言名称；
- 不接受地区代码，例如 `en-US`；
- 不接受历史代码，例如 `in`、`iw`。

`stripGeneratedSubtitleSuffix()` 不再通过宽松的 `getLanguageCode()` 判断文件名，而是使用这一严格判断。

### 3. 单语后缀

下列名称继续识别并剥离标准语言后缀：

```text
movie.en.srt
movie.fr.srt
movie.id.srt
movie.he.srt
```

下列名称不得剥离：

```text
movie.in.srt
movie.iw.srt
movie.English.srt
movie.英语.srt
movie.en-US.srt
```

例如翻译成英语时：

```text
movie.in.srt      → movie.in.en.srt
movie.iw.srt      → movie.iw.en.srt
My.French.srt     → My.French.en.srt
movie.en-US.srt   → movie.en-US.en.srt
love.in.la.srt    → love.in.la.en.srt
```

### 4. 双语后缀

双语后缀的两部分只允许：

- 程序生成的标准语言代码；
- `original`；
- `translated`。

因此：

```text
movie.en-zh.srt               可识别
movie.id-en.srt               可识别
movie.translated-original.srt 可识别
movie.in-en.srt               不识别为标准双语后缀
movie.English-zh.srt          不识别为标准双语后缀
```

双语输入与输出最终同名时，继续由现有的同名保护重复追加本次语言后缀。例如：

```text
movie.en-zh.srt → movie.en-zh.en-zh.srt
```

### 5. 旧版命名兼容

旧版常用名称：

```text
movie.translated.en.srt
```

仍然能够被识别，因为 `en` 是标准生成代码，程序会继续一并剥离 `.translated.en`。

下列非标准组合不再被主动剥离：

```text
movie.translated.in.srt
movie.translated.iw.srt
```

当前程序会将目标语言 `in` 输出为 `id`、将 `iw` 输出为 `he`，因此这不会破坏程序自身已经生成的标准文件名。

### 6. checkpoint 与路径保护

已有 checkpoint 中通过安全校验的输出身份应继续按原文件名复用，不因本次规则调整而重新命名。

只有创建全新输出身份，或者现有身份因指向输入文件而必须重建时，才使用新的严格剥离规则。

以下机制保持不变：

- 当前任务输入与输出同名保护；
- 其他活动任务输入保护；
- 输出路径独占；
- 危险旧 checkpoint 输出身份修正；
- 与活动输入无关的已有同名文件覆盖策略。

## 已知边界

标准代码仍可能恰好是标题的一部分。例如：

```text
movie.no.srt
movie.it.srt
```

因为 `no` 和 `it` 都是程序实际会生成的标准语言代码，它们仍会被当作语言后缀。这是保留 `movie.en.srt`、`movie.fr.srt` 等现有自动剥离行为所必须接受的歧义。

遇到这种少数情况时，由用户主动调整原文件名。程序不增加额外询问或推断逻辑。

## 测试

### 语言解析测试

- 所有27个标准代码继续正常解析。
- 英文、本族语、简繁中文别名继续正常解析。
- `in` 继续解析为 `id`。
- `iw` 继续解析为 `he`。
- `en-US` 等地区形式继续解析为标准代码。

### 文件名测试

- 标准单语代码可以剥离。
- 历史代码、语言名称和地区代码不得剥离。
- 标准双语组合可以剥离。
- 包含历史代码或语言名称的双语形态不得剥离。
- `.translated.<标准代码>` 继续兼容。
- `love.in.la.srt` 必须完整保留 `love.in.la`。

### 回归测试

- 输入输出同名时仍重复追加本次后缀。
- 跨任务输出仍不能覆盖任何活动输入。
- 安全 checkpoint 输出身份继续稳定续传。
- 危险 checkpoint 身份重建时使用新规则。
- 与活动输入无关的已有同名输出仍按现有策略覆盖。

## 验收标准

- 宽松语言识别行为没有减少。
- 文件名剥离不再接受语言名称、地区代码和历史代码。
- 标准代码、标准双语后缀和旧版 `.translated.<标准代码>` 保持兼容。
- 相关 TypeScript 检查、单元测试和 Electron E2E 测试全部通过。
- 自动生成的 E2E 截图差异不纳入提交。
