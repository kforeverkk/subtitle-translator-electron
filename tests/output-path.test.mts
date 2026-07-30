import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  getLanguageCode,
  getSubtitleLanguageSuffix,
  getTranslatedPath,
} from "../electron/main/utils/output-path.ts";

test("maps supported language names and codes", () => {
  assert.equal(getLanguageCode("Italian"), "it");
  assert.equal(getLanguageCode("意大利语"), "it");
  assert.equal(getLanguageCode("en-US"), "en");
  assert.equal(getLanguageCode("Tongan"), undefined);
  assert.equal(getLanguageCode("to"), undefined);
});

test("names translated-only output with the target language", () => {
  assert.equal(getSubtitleLanguageSuffix("srt-translation", "English"), "en");
  assert.equal(
    getSubtitleLanguageSuffix("srt-translation", "Vatican language"),
    "translated"
  );
});

test("names bilingual output in visual top-to-bottom language order", () => {
  assert.equal(
    getSubtitleLanguageSuffix("srt-bilingual", "English", "Chinese"),
    "en-zh"
  );
  assert.equal(
    getSubtitleLanguageSuffix(
      "ass-original-translation",
      "English",
      "Chinese"
    ),
    "zh-en"
  );
  assert.equal(
    getSubtitleLanguageSuffix(
      "srt-bilingual",
      "Vatican language",
      "Tongan"
    ),
    "translated-original"
  );
  assert.equal(
    getSubtitleLanguageSuffix(
      "srt-original-translation",
      "Vatican language",
      "Tongan"
    ),
    "original-translated"
  );
});

test("uses model-detected source language and removes an existing language suffix", () => {
  assert.equal(
    getTranslatedPath(
      path.join("subtitles", "movie.zh.srt"),
      "srt-bilingual",
      undefined,
      "movie.zh.srt",
      "English",
      "Italian"
    ),
    path.join("subtitles", "movie.en-it.srt")
  );
});
