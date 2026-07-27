import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  getTargetLanguageCode,
  getTranslatedPath,
} from "../electron/main/utils/output-path.ts";

test("maps target language names to ISO 639-1 output suffixes", () => {
  assert.equal(getTargetLanguageCode("English"), "en");
  assert.equal(getTargetLanguageCode("法语"), "fr");
  assert.equal(getTargetLanguageCode("日本語"), "ja");
  assert.equal(getTargetLanguageCode("en-US"), "en");
});

test("uses the target language code in the translated subtitle path", () => {
  assert.equal(
    getTranslatedPath(
      path.join("video", "movie.srt"),
      undefined,
      undefined,
      undefined,
      "English"
    ),
    path.join("video", "movie.en.srt")
  );
  assert.equal(
    getTranslatedPath(
      path.join("video", "movie.ass"),
      path.resolve("output"),
      undefined,
      undefined,
      "French"
    ),
    path.join(path.resolve("output"), "movie.fr.ass")
  );
});

test("falls back to translated for an unrecognized target language", () => {
  assert.equal(
    getTranslatedPath(
      path.join("video", "movie.vtt"),
      undefined,
      undefined,
      undefined,
      "Klingon"
    ),
    path.join("video", "movie.translated.vtt")
  );
});
