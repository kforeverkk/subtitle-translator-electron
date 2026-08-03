import assert from "node:assert/strict";
import test from "node:test";
import assStringify from "ass-stringify";
import {
  assTextToPlainText,
  createDefaultAssSections,
  formatSrtOutputText,
  getSubtitleOutputExtension,
  getSubtitleOutputFileSuffix,
  millisecondsToAssTimestamp,
  subtitleTimestampToMilliseconds,
} from "../electron/main/utils/subtitle-output.ts";
import { clearSubtitleCueTranslations } from "../electron/main/utils/subtitle-chunks.ts";

test("maps the selected output format to its file extension", () => {
  assert.equal(getSubtitleOutputExtension("srt-translation"), "srt");
  assert.equal(getSubtitleOutputExtension("srt-bilingual"), "srt");
  assert.equal(getSubtitleOutputExtension("srt-original-translation"), "srt");
  assert.equal(getSubtitleOutputExtension("ass-bilingual"), "ass");
  assert.equal(getSubtitleOutputExtension("ass-original-translation"), "ass");
  assert.equal(getSubtitleOutputFileSuffix("srt-translation"), "translated.srt");
  assert.equal(getSubtitleOutputFileSuffix("srt-bilingual"), "bilingual.srt");
  assert.equal(
    getSubtitleOutputFileSuffix("srt-original-translation"),
    "bilingual.original-translated.srt"
  );
  assert.equal(getSubtitleOutputFileSuffix("ass-bilingual"), "bilingual.ass");
  assert.equal(
    getSubtitleOutputFileSuffix("ass-original-translation"),
    "bilingual.original-translated.ass"
  );
});

test("creates a valid ASS skeleton when the source has no ASS styles", () => {
  const output = assStringify(
    createDefaultAssSections([
      { data: { start: 1_000, end: 2_500, text: "Original" } },
    ])
  );

  assert.match(output, /\[V4\+ Styles\]/);
  assert.match(output, /PlayResX: 384/);
  assert.match(output, /PlayResY: 288/);
  assert.match(output, /Timer: 100\.0000/);
  assert.match(output, /WrapStyle: 0/);
  assert.match(output, /ScaledBorderAndShadow: no/);
  assert.match(output, /Style: Default,Arial,20,/);
  assert.match(output, /,1,1,2,5,5,5,1/);
  assert.match(
    output,
    /Dialogue: 0,0:00:01\.00,0:00:02\.50,Default,,0000,0000,0000,,Original/
  );
});

test("formats translated-only and bilingual SRT text", () => {
  assert.equal(
    formatSrtOutputText({
      originalText: "Original",
      translatedText: "譯文",
      outputFormat: "srt-translation",
    }),
    "譯文"
  );
  assert.equal(
    formatSrtOutputText({
      originalText: "Original",
      translatedText: "譯文",
      outputFormat: "srt-bilingual",
    }),
    "譯文\nOriginal"
  );
  assert.equal(
    formatSrtOutputText({
      originalText: "Original",
      translatedText: "譯文",
      outputFormat: "srt-original-translation",
    }),
    "Original\n譯文"
  );
});

test("renders pending SRT cues as a single original line", () => {
  assert.equal(
    formatSrtOutputText({
      originalText: "Pending original",
      outputFormat: "srt-translation",
    }),
    "Pending original"
  );
  assert.equal(
    formatSrtOutputText({
      originalText: "Pending original",
      outputFormat: "srt-bilingual",
    }),
    "Pending original"
  );
  assert.equal(
    formatSrtOutputText({
      originalText: "Pending original",
      translatedText: "   ",
      outputFormat: "srt-original-translation",
    }),
    "Pending original"
  );
});

test("treats a non-empty translation identical to the original as complete", () => {
  assert.equal(
    formatSrtOutputText({
      originalText: "OK",
      translatedText: "OK",
      outputFormat: "srt-bilingual",
    }),
    "OK\nOK"
  );
});

test("renders only the original after a content-configuration restart", () => {
  const cues = [
    {
      data: {
        text: "原文",
        translatedText: "Previous English translation",
      },
    },
  ];

  clearSubtitleCueTranslations(cues);
  assert.equal(
    formatSrtOutputText({
      originalText: cues[0].data.text,
      translatedText: cues[0].data.translatedText,
      outputFormat: "srt-bilingual",
    }),
    "原文"
  );

  cues[0].data.translatedText = "最新日语译文";
  assert.equal(
    formatSrtOutputText({
      originalText: cues[0].data.text,
      translatedText: cues[0].data.translatedText,
      outputFormat: "srt-bilingual",
    }),
    "最新日语译文\n原文"
  );
});

test("converts ASS timestamps to milliseconds and back", () => {
  assert.equal(subtitleTimestampToMilliseconds("1:02:03.45"), 3_723_450);
  assert.equal(millisecondsToAssTimestamp(3_723_450), "1:02:03.45");
  assert.equal(millisecondsToAssTimestamp(59_999), "0:01:00.00");
  assert.throws(() => subtitleTimestampToMilliseconds("not-a-time"));
});

test("removes ASS overrides and vector drawings for plain SRT output", () => {
  assert.equal(
    assTextToPlainText(
      "{\\an8\\pos(10,20)}Title\\N{\\i1}Line{\\p1}m 0 0 l 1 1{\\p0}"
    ),
    "Title\nLine"
  );
});
