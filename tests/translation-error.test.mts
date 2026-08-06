import assert from "node:assert/strict";
import test from "node:test";
import {
  createSsaToAssConversionError,
  parseSsaToAssConversionError,
} from "../electron/shared/ssa-to-ass-error.ts";
import { translationErrorCodes } from "../electron/shared/translation-error-codes.ts";
import { getLocalizedTranslationError } from "../src/utils/translation-error.ts";

const messages: Record<string, string> = {
  "error.invalidCheckpoint": "检查点无效。",
  "error.requiredAnalysisCheckpoint":
    "必要的内容分析结果无法保存，字幕翻译尚未开始。请检查字幕目录的写入权限后重试。",
  "error.subtitleEncoding":
    "无法可靠识别该字幕的文本编码。请使用记事本、Notepad++ 等工具将字幕转换为 UTF-8 编码后重试。",
  "error.ssaToAssConversion":
    "SSA 转 ASS 格式转换失败（{location}）：{reason}。原字幕未覆盖，翻译进度仍保留。请修正源 SSA 格式，或改用 SRT 输出。",
  "error.ssaToAssConversion.invalidField": "字段值“{value}”无法安全转换",
};

const t = (id: string, values: Record<string, unknown> = {}) =>
  Object.entries(values).reduce(
    (message, [key, value]) => message.replaceAll(`{${key}}`, String(value)),
    messages[id] ?? id
  );

test("round-trips structured SSA to ASS conversion errors", () => {
  const details = {
    reason: "invalid-field" as const,
    location: "style Sign.Alignment",
    value: "12",
  };
  const error = createSsaToAssConversionError(details);

  assert.match(error.message, /^ERR_SSA_TO_ASS_CONVERSION:/);
  assert.deepEqual(parseSsaToAssConversionError(error.message), details);
});

test("rejects malformed SSA conversion payloads", () => {
  assert.equal(parseSsaToAssConversionError("ordinary error"), undefined);
  assert.equal(
    parseSsaToAssConversionError("ERR_SSA_TO_ASS_CONVERSION:not-json"),
    undefined
  );
  assert.equal(
    parseSsaToAssConversionError(
      `ERR_SSA_TO_ASS_CONVERSION:${encodeURIComponent(JSON.stringify({
        reason: "unknown",
        location: "Events",
      }))}`
    ),
    undefined
  );
});

test("keeps exact localization for existing translation error codes", () => {
  assert.equal(
    getLocalizedTranslationError(
      new Error(translationErrorCodes.invalidCheckpoint),
      "fallback",
      t
    ),
    "检查点无效。"
  );
});

test("explains how to recover from an unrecognized subtitle encoding", () => {
  assert.equal(
    getLocalizedTranslationError(
      new Error(translationErrorCodes.subtitleEncoding),
      "fallback",
      t
    ),
    "无法可靠识别该字幕的文本编码。请使用记事本、Notepad++ 等工具将字幕转换为 UTF-8 编码后重试。"
  );
});

test("explains that translation did not start when required analysis cannot be saved", () => {
  assert.equal(
    getLocalizedTranslationError(
      new Error(translationErrorCodes.requiredAnalysisCheckpoint),
      "fallback",
      t
    ),
    "必要的内容分析结果无法保存，字幕翻译尚未开始。请检查字幕目录的写入权限后重试。"
  );
});

test("renders a clear and actionable localized SSA conversion error", () => {
  const message = getLocalizedTranslationError(
    createSsaToAssConversionError({
      reason: "invalid-field",
      location: "style Sign.Alignment",
      value: "12",
    }),
    "fallback",
    t
  );

  assert.match(message, /SSA 转 ASS 格式转换失败/);
  assert.match(message, /style Sign\.Alignment/);
  assert.match(message, /12/);
  assert.match(message, /未覆盖/);
  assert.match(message, /进度仍保留/);
  assert.match(message, /改用 SRT 输出/);
});
