# 非 UTF-8 字幕安全识别实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 在字幕进入 SRT、VTT、ASS、SSA 解析器之前安全识别并解码常见旧编码，对低置信度、存在歧义或不受支持的输入明确失败，同时保证输出字幕和 checkpoint 继续统一使用 UTF-8。

**整体结构：** 新建独立的 Electron 主进程字幕解码工具，统一接管所有源字幕读取；JSON checkpoint 继续走现有严格 UTF-8 路径。解码工具先处理 BOM 和严格 UTF-8，再以高置信度和候选分差约束 `chardet`，最后交给 `iconv-lite` 解码。错误通过现有结构化错误码和三语言本地化链路显示，且必须发生在 API、输出及 checkpoint 写入之前。

**技术栈：** TypeScript、Electron 主进程、Node.js `Buffer`/`TextDecoder`、`chardet`、`iconv-lite`、Node Test Runner、Lingui、Playwright Electron E2E、electron-builder。

## 全局限制

- 仅处理 `srt`、`vtt`、`ass`、`ssa` 源字幕；JSON checkpoint 仍严格按 UTF-8 JSON 读取。
- 所有翻译输出字幕和新 checkpoint 仍统一写成 UTF-8。
- UTF-8 永远优先于统计检测；纯 ASCII 按 UTF-8 处理。
- 旧编码候选置信度必须不低于 80，且至少领先第二个不同且可解码候选 10 分。
- UTF-32 BOM、无受支持 BOM 但包含空字节、低置信度、候选接近、无法解码或出现替换字符的输入一律拒绝。
- ISO-2022 系列虽然可能被检测器识别，但 `iconv-lite` 不支持，必须拒绝并提示转换为 UTF-8。
- 编码失败必须发生在任何 API 请求、输出覆盖、新 checkpoint 或 checkpoint 备份写入之前。
- 不新增手动编码选择界面，不改变 checkpoint v1–v3 结构、路径、指纹、续传和 SSA 样式保留规则。

---

### 任务一：实现可独立验证的字幕字节解码器

**文件：**

- 新建：`electron/main/utils/subtitle-encoding.ts`
- 新建：`tests/subtitle-encoding.test.mts`
- 修改：`electron/shared/translation-error-codes.ts`
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`

**接口：**

- 输入：原始字幕 `Uint8Array`，以及测试时可选注入的候选分析函数。
- 输出：`decodeSubtitleBuffer(buffer, options)` 返回 `{ text: string; encoding: string }`。
- 输出：`readSubtitleFile(filePath)` 读取原始 `Buffer` 并复用 `decodeSubtitleBuffer`。
- 失败：统一抛出 `Error(translationErrorCodes.subtitleEncoding)`。

- [ ] **步骤 1：添加直接生产依赖**

运行：

```powershell
pnpm add chardet iconv-lite
```

预期：`package.json` 的 `dependencies` 出现两个直接依赖，`pnpm-lock.yaml` 更新，不增加原生二进制构建步骤。随后在 `electron/shared/translation-error-codes.ts` 增加：

```ts
subtitleEncoding: "ERR_SUBTITLE_ENCODING_UNRECOGNIZED",
```

- [ ] **步骤 2：先写 BOM、UTF-8 和严格拒绝的失败测试**

在 `tests/subtitle-encoding.test.mts` 写入以下行为测试，并把该文件加入 `package.json` 的 `test` 脚本：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import iconv from "iconv-lite";
import { translationErrorCodes } from "../electron/shared/translation-error-codes.ts";
import { decodeSubtitleBuffer } from "../electron/main/utils/subtitle-encoding.ts";

const noStatisticalDetection = () => {
  throw new Error("statistical detection must not run");
};

test("decodes UTF-8, ASCII, and supported Unicode BOMs without statistical detection", () => {
  assert.deepEqual(
    decodeSubtitleBuffer(Buffer.from("字幕", "utf8"), { analyse: noStatisticalDetection }),
    { text: "字幕", encoding: "utf-8" },
  );
  assert.deepEqual(
    decodeSubtitleBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x41]), { analyse: noStatisticalDetection }),
    { text: "A", encoding: "utf-8" },
  );
  assert.deepEqual(
    decodeSubtitleBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode("字幕", "utf16-le")]), { analyse: noStatisticalDetection }),
    { text: "字幕", encoding: "utf-16le" },
  );
  assert.deepEqual(
    decodeSubtitleBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode("字幕", "utf16-be")]), { analyse: noStatisticalDetection }),
    { text: "字幕", encoding: "utf-16be" },
  );
});

test("rejects UTF-32 BOM and BOM-less NUL bytes", () => {
  for (const bytes of [
    Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]),
    Buffer.from([0x41, 0x00, 0x42, 0x00]),
  ]) {
    assert.throws(
      () => decodeSubtitleBuffer(bytes, { analyse: noStatisticalDetection }),
      new RegExp(translationErrorCodes.subtitleEncoding),
    );
  }
});
```

- [ ] **步骤 3：运行测试，确认因解码器尚不存在而失败**

运行：

```powershell
pnpm test
```

预期：失败原因是无法导入 `subtitle-encoding.ts` 或缺少 `decodeSubtitleBuffer`，不是测试语法错误。

- [ ] **步骤 4：实现确定性 Unicode 路径和错误入口**

在 `electron/main/utils/subtitle-encoding.ts` 建立以下接口和处理顺序：

```ts
import fs from "node:fs";
import chardet from "chardet";
import iconv from "iconv-lite";
import { translationErrorCodes } from "../../shared/translation-error-codes";

export interface SubtitleEncodingCandidate {
  name: string;
  confidence: number;
}

export interface DecodeSubtitleOptions {
  analyse?: (buffer: Uint8Array) => readonly SubtitleEncodingCandidate[];
}

export interface DecodedSubtitleText {
  text: string;
  encoding: string;
}

function encodingError(): Error {
  return new Error(translationErrorCodes.subtitleEncoding);
}

export function decodeSubtitleBuffer(
  input: Uint8Array,
  options: DecodeSubtitleOptions = {},
): DecodedSubtitleText {
  const buffer = Buffer.from(input);
  if (
    buffer.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0x00, 0x00])) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0xfe, 0xff]))
  ) {
    throw encodingError();
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(3)),
      encoding: "utf-8",
    };
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return decodeBomUnicode(buffer.subarray(2), "utf16-le", "utf-16le");
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return decodeBomUnicode(buffer.subarray(2), "utf16-be", "utf-16be");
  }
  if (buffer.includes(0)) throw encodingError();
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      encoding: "utf-8",
    };
  } catch {
    return decodeDetectedLegacyEncoding(buffer, options.analyse ?? chardet.analyse);
  }
}

export function readSubtitleFile(filePath: string): DecodedSubtitleText {
  return decodeSubtitleBuffer(fs.readFileSync(filePath));
}
```

严格 UTF-8 使用 `new TextDecoder("utf-8", { fatal: true })`，不得通过检查解码后是否含 `�` 来代替 fatal 验证。BOM 必须从最终文本中移除。`decodeBomUnicode` 使用 `iconv.decode` 后必须把文本按同一 UTF-16 编码重新编码并与去除 BOM 后的原始字节逐字节比较；不一致就抛出编码错误，以拒绝截断或非法 UTF-16。

- [ ] **步骤 5：补写旧编码候选判定的失败测试**

使用 `iconv.encode` 生成原始字节，并注入固定候选，覆盖：GB18030、Big5、Shift_JIS、EUC-JP、EUC-KR、Windows-1252；同时覆盖低于 80 分、领先不足 10 分、ISO-2022-JP 和未知名称：

```ts
test("accepts only a high-confidence legacy encoding with a clear lead", () => {
  const source = "1\n00:00:00,000 --> 00:00:01,000\n简体中文字幕\n";
  const decoded = decodeSubtitleBuffer(iconv.encode(source, "gb18030"), {
    analyse: () => [
      { name: "GB18030", confidence: 100 },
      { name: "Big5", confidence: 20 },
    ],
  });
  assert.equal(decoded.text, source);
  assert.equal(decoded.encoding, "gb18030");
});

test("rejects low-confidence, close, and unsupported candidates", () => {
  const invalidUtf8 = Buffer.from([0x81, 0x82, 0x83]);
  for (const candidates of [
    [{ name: "GB18030", confidence: 79 }],
    [{ name: "GB18030", confidence: 90 }, { name: "Big5", confidence: 81 }],
    [{ name: "ISO-2022-JP", confidence: 100 }],
    [{ name: "vendor-unknown", confidence: 100 }],
  ]) {
    assert.throws(
      () => decodeSubtitleBuffer(invalidUtf8, { analyse: () => candidates }),
      new RegExp(translationErrorCodes.subtitleEncoding),
    );
  }
});
```

- [ ] **步骤 6：实现候选标准化、阈值、解码和无损检查**

实现以下规则：

```ts
const minimumConfidence = 80;
const minimumLead = 10;
const replacementCharacter = "\uFFFD";

const canonicalAliases: Record<string, string> = {
  gb18030: "gb18030",
  big5: "big5",
  shiftjis: "shift_jis",
  eucjp: "euc-jp",
  euckr: "euc-kr",
  windows874: "windows-874",
  windows1250: "windows-1250",
  windows1251: "windows-1251",
  windows1252: "windows-1252",
  windows1253: "windows-1253",
  windows1254: "windows-1254",
  windows1255: "windows-1255",
  windows1256: "windows-1256",
  windows1257: "windows-1257",
  windows1258: "windows-1258",
};
```

名称归一化时删除大小写、连字符和下划线差异。实现 `canonicalizeEncoding(name)`：先查询上面的别名表；再把匹配 `^iso8859(\d+)$` 的名称恢复为 `iso-8859-$1`；最后必须通过 `iconv.encodingExists`。过滤不受支持候选、按标准编码去重并保留最高分，再计算第一、第二候选的分差。只有一个可解码候选时，达到 80 分即可接受。

解码后拒绝 `\uFFFD`。对最终采用的旧编码执行 `iconv.encode(text, encoding)` 与原始字节比较；不一致时安全拒绝，不尝试修补或忽略字节。

- [ ] **步骤 7：运行解码器测试并加入真实检测样本**

增加一组不注入 `analyse` 的长文本样本，至少验证 GB18030、Big5、Shift_JIS 和 Windows-1252 的真实 `chardet + iconv-lite` 组合；样本内容重复若干句，避免短文本统计不稳定。

运行：

```powershell
pnpm test
```

预期：全部通过；如真实检测器无法达到设计阈值，保留安全拒绝，不降低阈值，并把该编码调整为“需用户转 UTF-8”的实际边界。

- [ ] **步骤 8：提交解码器**

```powershell
git add package.json pnpm-lock.yaml electron/shared/translation-error-codes.ts electron/main/utils/subtitle-encoding.ts tests/subtitle-encoding.test.mts
git commit -m "feat: decode subtitle source encodings safely"
```

---

### 任务二：加入结构化错误码和三语言提示

**文件：**

- 修改：`electron/shared/translation-error-codes.ts`
- 修改：`src/utils/translation-error.ts`
- 修改：`src/i18n-messages.ts`
- 修改：`src/locales/en-US.po`
- 修改：`src/locales/zh-CN.po`
- 修改：`src/locales/zh-TW.po`
- 修改：`tests/translation-error.test.mts`

**接口：**

- 消费：任务一新增的 `translationErrorCodes.subtitleEncoding = "ERR_SUBTITLE_ENCODING_UNRECOGNIZED"`。
- 新增本地化 ID：`error.subtitleEncoding`。
- 解码器错误经现有 `getLocalizedTranslationError` 映射，无需改变 IPC 错误结构。

- [ ] **步骤 1：先写错误映射失败测试**

在 `tests/translation-error.test.mts` 增加：

```ts
test("localizes an unrecognized subtitle encoding with conversion guidance", () => {
  const calls: string[] = [];
  const rendered = getLocalizedTranslationError(
    new Error(translationErrorCodes.subtitleEncoding),
    (id) => {
      calls.push(id);
      return id === "error.subtitleEncoding"
        ? "请将字幕转换为 UTF-8 编码后重试。"
        : id;
    },
  );
  assert.equal(rendered, "请将字幕转换为 UTF-8 编码后重试。");
  assert.deepEqual(calls, ["error.subtitleEncoding"]);
});
```

- [ ] **步骤 2：运行测试，确认新错误映射尚不存在**

运行：

```powershell
pnpm test
```

预期：失败，表明错误码或 `error.subtitleEncoding` 映射尚未实现。

- [ ] **步骤 3：实现错误码、消息声明和三种翻译**

消息内容固定为：

```text
en-US: The subtitle text encoding could not be identified reliably. Convert the subtitle to UTF-8 with Notepad, Notepad++, or another text editor, then try again.
zh-CN: 无法可靠识别该字幕的文本编码。请使用记事本、Notepad++ 等工具将字幕转换为 UTF-8 编码后重试。
zh-TW: 無法可靠識別該字幕的文字編碼。請使用記事本、Notepad++ 等工具將字幕轉換為 UTF-8 編碼後再試一次。
```

在 `translationErrorMessageIds` 增加：

```ts
[translationErrorCodes.subtitleEncoding]: "error.subtitleEncoding",
```

运行 `pnpm i18n:extract` 后只保留与新消息有关的 PO 变化，避免无关目录重排；再运行 `pnpm i18n:compile` 验证三种目录可编译。

- [ ] **步骤 4：验证映射和语言目录**

运行：

```powershell
pnpm test
pnpm i18n:compile
git diff --check
```

预期：测试通过，三个 `.po` 都包含非空 `error.subtitleEncoding`，没有无关翻译变更。

- [ ] **步骤 5：提交本地化错误**

```powershell
git add electron/shared/translation-error-codes.ts src/utils/translation-error.ts src/i18n-messages.ts src/locales/en-US.po src/locales/zh-CN.po src/locales/zh-TW.po tests/translation-error.test.mts
git commit -m "feat: explain unsupported subtitle encodings"
```

---

### 任务三：让所有源字幕读取分支使用统一解码器

**文件：**

- 修改：`electron/main/index.ts`
- 修改：`tests/ssa-translation-integration.test.mts`
- 新建：`tests/subtitle-encoding-integration.test.mts`
- 修改：`package.json`

**接口：**

- 消费：任务一的 `readSubtitleFile(filePath): DecodedSubtitleText`。
- 保持：`parseSubtitle(fileContent, extension)` 接口、checkpoint v3 结构、`subtitle.source.text` 字段及源文件指纹算法不变。

- [ ] **步骤 1：先写四种格式解析与 SSA 原文保留的失败测试**

在 `tests/subtitle-encoding-integration.test.mts` 中，用 `iconv-lite` 生成长且有代表性的文件字节，写入临时目录，再调用 `readSubtitleFile` 和现有 `parseSubtitle`：

```ts
test("legacy-encoded SRT, VTT, ASS, and SSA reach parsers as Unicode", () => {
  const cases = [
    { extension: "srt", encoding: "gb18030", text: "简体中文字幕" },
    { extension: "vtt", encoding: "windows-1252", text: "Crème brûlée déjà vu" },
    { extension: "ass", encoding: "big5", text: "繁體中文字幕" },
    { extension: "ssa", encoding: "shift_jis", text: "日本語字幕テスト" },
  ] as const;
  for (const item of cases) {
    const cueText = Array.from({ length: 20 }, () => item.text).join(" ");
    const source = createValidSubtitleDocument(item.extension, cueText);
    const filePath = path.join(temporaryDirectory, `sample.${item.extension}`);
    writeFileSync(filePath, iconv.encode(source, item.encoding));
    const decoded = readSubtitleFile(filePath);
    assert.match(decoded.text, new RegExp(item.text));
    const parsed = parseSubtitle(decoded.text, item.extension);
    assert.match(getSubtitleCues(parsed)[0].data.text, new RegExp(item.text));
  }
});
```

同一测试文件中的 `createValidSubtitleDocument` 必须分别返回带一个有效 cue 的 SRT、WEBVTT、ASS v4+ 和 SSA v4 文档；ASS 使用 `[V4+ Styles]` 与 `Layer` 事件格式，SSA 使用 `[V4 Styles]` 与 `Marked` 事件格式，不能用同一模板假装两种格式等价。

在现有 SSA 集成测试增加断言：解码后的 `source.text` 写入 checkpoint、序列化并读回后仍是正确日文，随后 ASS 输出保留样式和事件。

- [ ] **步骤 2：运行集成测试，确认生产读取路径尚未接入**

运行：

```powershell
pnpm test
```

预期：至少一个测试因 `index.ts` 仍按 UTF-8 读取源字幕或集成辅助接口尚未接入而失败。

- [ ] **步骤 3：替换所有源字幕的直接 UTF-8 读取**

在 `electron/main/index.ts` 导入 `readSubtitleFile`，并集中成：

```ts
function parseSourceSubtitle(
  filePath: string,
  sourceExtension: SubtitleFileExtension,
): ParsedSubtitle {
  return parseSubtitle(readSubtitleFile(filePath).text, sourceExtension);
}
```

替换以下分支：

- `attachCurrentSsaSource` 中的 `source.text`；
- 同 task checkpoint 文件存在但内容无效时的源字幕回退；
- 无法验证 v1 checkpoint 时的干净重启；
- 没有 checkpoint 的全新翻译。

`readCheckpoint` 和用户直接选择 `.json` checkpoint 的路径必须继续使用 `fs.readFileSync(..., "utf8")`，不可改用编码检测。

- [ ] **步骤 4：验证没有遗漏或误改读取入口**

运行：

```powershell
rg -n 'readFileSync\(filePath, "utf8"\)' electron/main/index.ts
pnpm test
```

预期：剩余匹配只属于 JSON checkpoint；四种字幕格式、SSA 和全部 checkpoint 回归测试通过。

- [ ] **步骤 5：验证输出继续是 UTF-8**

在集成测试中读取生成输出的原始字节，用 fatal UTF-8 解码器验证，并确认内容没有 `\uFFFD`。JSON checkpoint 同样进行严格 UTF-8 解码和 `JSON.parse`。

运行：

```powershell
pnpm test
```

预期：通过，且输出命名断言不变。

- [ ] **步骤 6：提交读取链路接入**

```powershell
git add electron/main/index.ts tests/ssa-translation-integration.test.mts tests/subtitle-encoding-integration.test.mts package.json
git commit -m "fix: decode subtitle files before parsing"
```

---

### 任务四：验证实际 GUI 成功与失败路径

**文件：**

- 修改：`e2e/example.spec.ts`

**接口：**

- 消费：现有真实任务对话框、任务状态表格、错误详情弹窗和模拟 OpenAI 服务。
- 证明：旧编码成功路径确实进入翻译；歧义失败路径在 API、输出和 checkpoint 之前停止。

- [ ] **步骤 1：先写真实 GUI 成功测试**

新增测试，通过 `input[type="file"]` 选择由 `iconv.encode` 写出的长 GB18030 SRT：

```ts
test("the real GUI translates a confidently detected legacy-encoded subtitle", async () => {
  const requestBodies: string[] = [];
  const sourceText = Array.from({ length: 20 }, (_, index) =>
    `${index + 1}\n00:00:${String(index).padStart(2, "0")},000 --> 00:00:${String(index + 1).padStart(2, "0")},000\n可靠识别的简体中文字幕\n`,
  ).join("\n");
  writeFileSync(sourcePath, iconv.encode(sourceText, "gb18030"));
  const mockServer = await startMockOpenAiServer({
    getStreamElements: (bodyText) => {
      requestBodies.push(bodyText);
      const count = Number(bodyText.match(/exactly (\d+) translated strings/i)?.[1] ?? 1);
      return Array.from({ length: count }, (_, index) => `Translation ${index + 1}`);
    },
  });
  // 按现有真实任务 GUI 测试设置 localStorage，使用 input[type=file] 添加 sourcePath。
  await expect(page.getByRole("row").filter({ hasText: "movie.srt" }).getByText("Completed", { exact: true })).toBeVisible();
  expect(requestBodies.join("\n")).toContain("可靠识别的简体中文字幕");
  expect(requestBodies.join("\n")).not.toContain("�");
  const outputBytes = readFileSync(path.join(temporaryDirectory, "movie.en.srt"));
  const outputText = new TextDecoder("utf-8", { fatal: true }).decode(outputBytes);
  expect(outputText).toContain("Translation 1");
});
```

这里的 localStorage 键和值固定复用现有 GUI 测试所使用的 `language=en-US`、`api_keys=["test-key"]`、mock `api_host`、`model=test-model`、包含 `{{lang}}` 与 `{{additional}}` 的 prompt、`translate_lang=English`、`delay=0`、`requests_per_minute=1000`、`translation_concurrency=1` 和 `subtitle_output_format=srt-translation`，不得绕过界面直接调用批处理 IPC。

- [ ] **步骤 2：先写真实 GUI 安全失败测试**

构造严格 UTF-8 无效并让真实检测结果不可靠的短二进制字幕；如果统计结果在当前版本恰好达到阈值，则改用 UTF-32 BOM 样本形成确定性失败：

```ts
test("the real GUI explains ambiguous encoding before API or file writes", async () => {
  writeFileSync(sourcePath, Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]));
  writeFileSync(outputPath, "sentinel", "utf8");
  const requestBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => requestBodies.push(bodyText),
  });
  // 设置简体中文 localStorage，通过真实文件输入框和 Add task 按钮添加任务。
  const taskRow = page.getByRole("row").filter({ hasText: "ambiguous.srt" });
  await expect(taskRow.getByText("失败", { exact: true })).toBeVisible();
  await taskRow.getByRole("button", { name: "查看 ambiguous.srt 的翻译详情" }).click();
  await expect(page.locator("pre")).toContainText("请使用记事本、Notepad++ 等工具将字幕转换为 UTF-8 编码后重试");
  expect(requestBodies).toHaveLength(0);
  expect(readFileSync(outputPath, "utf8")).toBe("sentinel");
  expect(readdirSync(temporaryDirectory).filter((name) => name.includes(".translation.") || name.endsWith(".backup.json"))).toEqual([]);
});
```

失败测试同样使用现有真实 GUI 测试的完整 localStorage 配置，只把 `language` 改为 `zh-CN`。`outputPath` 必须通过生产 `getOutputPath` 所遵循的命名规则确定为目标英语字幕路径，不能随意取一个不会被生产代码访问的文件名。

同一测试把界面语言切换为简体中文，断言显示：

```text
无法可靠识别该字幕的文本编码。请使用记事本、Notepad++ 等工具将字幕转换为 UTF-8 编码后重试。
```

- [ ] **步骤 3：运行新增 Electron E2E 测试**

运行：

```powershell
pnpm run pree2e
pnpm exec playwright test --grep "legacy-encoded subtitle|ambiguous encoding"
```

预期：两项均通过；成功路径至少产生一次 API 请求，失败路径为零请求且没有文件变更。

- [ ] **步骤 4：提交 GUI 回归测试**

```powershell
git add e2e/example.spec.ts
git commit -m "test: cover subtitle encodings in Electron"
```

---

### 任务五：完整回归、构建和本地交付检查

**文件：**

- 只允许测试产生的可恢复构建产物；不再修改源代码。

**接口：**

- 验证任务一至四的全部成果及项目既有机制。

- [ ] **步骤 1：运行完整静态检查和单元测试**

运行：

```powershell
pnpm run check
```

预期：TypeScript 两套配置均通过，全部 Node 测试通过，无跳过的单元测试。

- [ ] **步骤 2：运行完整 Electron E2E**

先取得当前提交短 SHA，并用其构建测试版本：

```powershell
$commit = git rev-parse --short HEAD
$env:VITE_COMMIT_SHA = $commit
pnpm run pree2e
pnpm run e2e
```

预期：除需要显式指定打包可执行文件的测试外，其余 E2E 全部通过；新增编码 GUI 测试通过。

- [ ] **步骤 3：构建当前 Windows 安装包和解包应用**

```powershell
pnpm run build
```

预期：检查、Vite 构建和 electron-builder 均成功；`release/win-unpacked/` 中生成当前源码构建的可执行文件，不使用电脑上已安装的旧版本。

- [ ] **步骤 4：对刚生成的可执行文件运行打包 GUI 冒烟测试**

```powershell
$env:SUBTITLE_TRANSLATOR_PACKAGED_EXE = (Resolve-Path "release/win-unpacked/subtitle-translator.exe").Path
pnpm exec playwright test --grep "packaged Windows GUI uses the current isolated build"
```

如果实际可执行文件名不同，只允许从 `release/win-unpacked/` 中解析唯一 `.exe`，并先核对绝对路径确实位于当前工作区；不得使用系统已安装版本。

预期：测试确认运行路径、应用版本、隔离用户数据目录和设置语言切换都来自刚生成的本地应用。

- [ ] **步骤 5：检查工作区和提交历史**

```powershell
git diff --check
git status --short --branch
git log --oneline --decorate -8
```

如果 E2E 只改动 `e2e/screenshots/example.png`，恢复该测试截图；其他未知修改必须调查，不能删除或覆盖用户文件。

预期：工作区干净，本地 `main` 领先 `origin/main`，没有执行 push。
