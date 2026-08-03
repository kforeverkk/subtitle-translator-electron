import assert from "node:assert/strict";
import test from "node:test";
import iconv from "iconv-lite";
import { translationErrorCodes } from "../electron/shared/translation-error-codes.ts";
import {
  decodeSubtitleBuffer,
  type SubtitleEncodingCandidate,
} from "../electron/main/utils/subtitle-encoding.ts";

const encodingError = new RegExp(translationErrorCodes.subtitleEncoding);

const noStatisticalDetection = (): readonly SubtitleEncodingCandidate[] => {
  throw new Error("statistical detection must not run");
};

test("decodes strict UTF-8 and ASCII without statistical detection", () => {
  assert.deepEqual(
    decodeSubtitleBuffer(Buffer.from("字幕", "utf8"), {
      analyse: noStatisticalDetection,
    }),
    { text: "字幕", encoding: "utf-8" }
  );
  assert.deepEqual(
    decodeSubtitleBuffer(Buffer.from("plain ASCII", "ascii"), {
      analyse: noStatisticalDetection,
    }),
    { text: "plain ASCII", encoding: "utf-8" }
  );
});

test("decodes supported Unicode BOMs and removes the marker", () => {
  assert.deepEqual(
    decodeSubtitleBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x41]), {
      analyse: noStatisticalDetection,
    }),
    { text: "A", encoding: "utf-8" }
  );
  assert.deepEqual(
    decodeSubtitleBuffer(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        iconv.encode("字幕", "utf16-le"),
      ]),
      { analyse: noStatisticalDetection }
    ),
    { text: "字幕", encoding: "utf-16le" }
  );
  assert.deepEqual(
    decodeSubtitleBuffer(
      Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        iconv.encode("字幕", "utf16-be"),
      ]),
      { analyse: noStatisticalDetection }
    ),
    { text: "字幕", encoding: "utf-16be" }
  );
});

test("rejects malformed BOM text, UTF-32, and BOM-less NUL bytes", () => {
  for (const bytes of [
    Buffer.from([0xef, 0xbb, 0xbf, 0xff]),
    Buffer.from([0xff, 0xfe, 0x41]),
    Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x41]),
    Buffer.from([0x41, 0x00, 0x42, 0x00]),
  ]) {
    assert.throws(
      () =>
        decodeSubtitleBuffer(bytes, { analyse: noStatisticalDetection }),
      encodingError
    );
  }
});

test("accepts a high-confidence supported legacy encoding with a clear lead", () => {
  const cases = [
    ["gb18030", "GB18030", "简体中文字幕"],
    ["big5", "Big5", "繁體中文字幕"],
    ["shift_jis", "Shift_JIS", "日本語字幕テスト"],
    ["euc-jp", "EUC-JP", "日本語字幕テスト"],
    ["euc-kr", "EUC-KR", "한국어 자막 테스트"],
    ["windows-1252", "windows-1252", "Crème brûlée déjà vu"],
  ] as const;

  for (const [encoding, detectorName, text] of cases) {
    assert.deepEqual(
      decodeSubtitleBuffer(iconv.encode(text, encoding), {
        analyse: () => [
          { name: detectorName, confidence: 100 },
          { name: "windows-1251", confidence: 20 },
        ],
      }),
      { text, encoding }
    );
  }
});

test("rejects low-confidence, close, unsupported, and lossy candidates", () => {
  const invalidUtf8 = Buffer.from([0x81, 0x82, 0x83]);
  const candidateSets: SubtitleEncodingCandidate[][] = [
    [{ name: "GB18030", confidence: 79 }],
    [
      { name: "GB18030", confidence: 90 },
      { name: "Big5", confidence: 81 },
    ],
    [{ name: "ISO-2022-JP", confidence: 100 }],
    [{ name: "vendor-unknown", confidence: 100 }],
    [{ name: "windows-1252", confidence: 100 }],
  ];

  for (const candidates of candidateSets) {
    assert.throws(
      () =>
        decodeSubtitleBuffer(invalidUtf8, { analyse: () => candidates }),
      encodingError
    );
  }
});

test("keeps the highest score per canonical encoding before comparing the lead", () => {
  const text = "简体中文字幕";
  assert.deepEqual(
    decodeSubtitleBuffer(iconv.encode(text, "gb18030"), {
      analyse: () => [
        { name: "GB18030", confidence: 95 },
        { name: "gb-18030", confidence: 92 },
        { name: "Big5", confidence: 70 },
      ],
    }),
    { text, encoding: "gb18030" }
  );
});

test("detects representative East Asian legacy subtitle text with the real detector", () => {
  const cases = [
    ["gb18030", "简体中文字幕测试，这是一段用于识别编码的长文本。"],
    ["big5", "繁體中文字幕測試，這是一段用於識別編碼的長文字。"],
    ["shift_jis", "日本語字幕のエンコーディングを確認するための長いテスト文章です。"],
    ["euc-jp", "日本語字幕のエンコーディングを確認するための長いテスト文章です。"],
    ["euc-kr", "한국어 자막 인코딩을 확인하기 위한 충분히 긴 테스트 문장입니다."],
  ] as const;

  for (const [encoding, sentence] of cases) {
    const text = Array.from({ length: 30 }, () => sentence).join(" ");
    assert.equal(decodeSubtitleBuffer(iconv.encode(text, encoding)).text, text);
  }
});

test("rejects ambiguous Western legacy text with the real detector", () => {
  const sentence = "Crème brûlée, déjà vu, façade, naïve, voilà et garçon.";
  const text = Array.from({ length: 30 }, () => sentence).join(" ");
  assert.throws(
    () => decodeSubtitleBuffer(iconv.encode(text, "windows-1252")),
    encodingError
  );
});
