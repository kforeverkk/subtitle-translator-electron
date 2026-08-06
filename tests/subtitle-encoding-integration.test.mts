import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import iconv from "iconv-lite";
import {
  getSubtitleCues,
  parseSubtitleFile,
  readSubtitleSourceSnapshot,
  serializeTranslatedSubtitle,
  type SubtitleFileExtension,
} from "../electron/main/utils/translate.ts";

function createSrt(text: string): string {
  return `1\n00:00:00,000 --> 00:00:02,000\n${text}\n`;
}

function createVtt(text: string): string {
  return `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${text}\n`;
}

function createAss(text: string): string {
  return `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0000,0000,0000,,${text}
`;
}

function createSsa(text: string): string {
  return `[Script Info]
ScriptType: v4.00

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding
Style: Default,Arial,20,16777215,65535,0,0,0,0,1,2,1,2,10,10,10,0,1

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:00.00,0:00:02.00,Default,,0000,0000,0000,,${text}
`;
}

test("parses legacy-encoded SRT, VTT, ASS, and SSA files as Unicode", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-encoding-formats-")
  );
  try {
    const cases: Array<{
      extension: SubtitleFileExtension;
      encoding: string;
      sentence: string;
      source: (text: string) => string;
    }> = [
      {
        extension: "srt",
        encoding: "gb18030",
        sentence: "简体中文字幕测试，这是一段用于识别编码的长文本。",
        source: createSrt,
      },
      {
        extension: "vtt",
        encoding: "euc-kr",
        sentence: "한국어 자막 인코딩을 확인하기 위한 충분히 긴 테스트 문장입니다.",
        source: createVtt,
      },
      {
        extension: "ass",
        encoding: "big5",
        sentence: "繁體中文字幕測試，這是一段用於識別編碼的長文字。",
        source: createAss,
      },
      {
        extension: "ssa",
        encoding: "shift_jis",
        sentence: "日本語字幕のエンコーディングを確認するための長いテスト文章です。",
        source: createSsa,
      },
    ];

    for (const item of cases) {
      const cueText = Array.from({ length: 20 }, () => item.sentence).join(" ");
      const filePath = path.join(
        temporaryDirectory,
        `sample.${item.extension}`
      );
      writeFileSync(filePath, iconv.encode(item.source(cueText), item.encoding));

      const parsed = parseSubtitleFile(filePath, item.extension);
      assert.match(getSubtitleCues(parsed)[0].data.text, new RegExp(item.sentence));
      if (item.extension === "ssa") {
        assert.equal(Array.isArray(parsed), false);
        if (!Array.isArray(parsed)) {
          assert.match(parsed.source?.text ?? "", new RegExp(item.sentence));
        }
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("writes translated output from a legacy source as strict UTF-8", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-encoding-output-")
  );
  try {
    const sourcePath = path.join(temporaryDirectory, "movie.srt");
    const outputPath = path.join(temporaryDirectory, "movie.en.srt");
    const sentence = "简体中文字幕测试，这是一段用于识别编码的长文本。";
    const cueText = Array.from({ length: 20 }, () => sentence).join(" ");
    writeFileSync(sourcePath, iconv.encode(createSrt(cueText), "gb18030"));

    const parsed = parseSubtitleFile(sourcePath, "srt");
    getSubtitleCues(parsed)[0].data.translatedText = "Correct translation";
    writeFileSync(
      outputPath,
      serializeTranslatedSubtitle(
        parsed,
        "srt-translation",
        {},
        "srt"
      ),
      "utf8"
    );

    const outputBytes = readFileSync(outputPath);
    const output = new TextDecoder("utf-8", { fatal: true }).decode(
      outputBytes
    );
    assert.match(output, /Correct translation/);
    assert.doesNotMatch(output, /�/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("reads, decodes, parses, and fingerprints one immutable source buffer", () => {
  const sentence = "简体中文字幕测试，这是一段用于识别编码的长文本。";
  const cueText = Array.from({ length: 20 }, () => sentence).join(" ");
  const sourceText = createSrt(cueText);
  const gb18030 = iconv.encode(sourceText, "gb18030");
  const utf8 = Buffer.from(sourceText, "utf8");
  let reads = 0;

  const legacySnapshot = readSubtitleSourceSnapshot(
    "ignored.srt",
    "srt",
    { size: gb18030.length, mtimeMs: 100 },
    {
      readFile: () => {
        reads += 1;
        return gb18030;
      },
    }
  );
  const utf8Snapshot = readSubtitleSourceSnapshot(
    "ignored.srt",
    "srt",
    { size: utf8.length, mtimeMs: 200 },
    { readFile: () => utf8 }
  );

  assert.equal(reads, 1);
  assert.match(getSubtitleCues(legacySnapshot.parsed)[0].data.text, /简体中文/);
  assert.equal(legacySnapshot.encoding, "gb18030");
  assert.equal(
    legacySnapshot.fingerprint.rawHash,
    createHash("sha256").update(gb18030).digest("hex")
  );
  assert.notEqual(
    legacySnapshot.fingerprint.rawHash,
    utf8Snapshot.fingerprint.rawHash
  );
  assert.equal(
    legacySnapshot.fingerprint.contentHash,
    utf8Snapshot.fingerprint.contentHash
  );
});
