import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createTranslationOutputIdentity,
  getLanguageCode,
  getReusableTranslationOutputIdentity,
  getSubtitleLanguageSuffix,
  getTranslatedPath,
  getTranslatedPathFromOutputIdentity,
  isReusableTranslationOutputIdentity,
  isTranslationOutputIdentity,
} from "../electron/main/utils/output-path.ts";

test("maps supported language names and codes", () => {
  assert.equal(getLanguageCode("Italian"), "it");
  assert.equal(getLanguageCode("意大利语"), "it");
  assert.equal(getLanguageCode("en-US"), "en");
  assert.equal(getLanguageCode("Tongan"), undefined);
  assert.equal(getLanguageCode("to"), undefined);
});

test("maps the extended common subtitle languages and aliases", () => {
  const cases: Array<{
    code: string;
    aliases: string[];
  }> = [
    { code: "nl", aliases: ["Dutch", "Nederlands", "荷兰语", "荷蘭語"] },
    { code: "pl", aliases: ["Polish", "Polski", "波兰语", "波蘭語"] },
    { code: "tr", aliases: ["Turkish", "Türkçe", "Turkce", "土耳其语", "土耳其語"] },
    {
      code: "vi",
      aliases: ["Vietnamese", "Tiếng Việt", "Tieng Viet", "越南语", "越南語"],
    },
    { code: "th", aliases: ["Thai", "ไทย", "泰语", "泰語"] },
    {
      code: "id",
      aliases: [
        "Indonesian",
        "Bahasa Indonesia",
        "印度尼西亚语",
        "印度尼西亞語",
        "印尼语",
        "印尼語",
        "in",
      ],
    },
    {
      code: "uk",
      aliases: ["Ukrainian", "Українська", "乌克兰语", "烏克蘭語"],
    },
    {
      code: "he",
      aliases: ["Hebrew", "עברית", "希伯来语", "希伯來語", "iw"],
    },
    { code: "cs", aliases: ["Czech", "Čeština", "Cestina", "捷克语", "捷克語"] },
    { code: "sv", aliases: ["Swedish", "Svenska", "瑞典语", "瑞典語"] },
    { code: "da", aliases: ["Danish", "Dansk", "丹麦语", "丹麥語"] },
    { code: "fi", aliases: ["Finnish", "Suomi", "芬兰语", "芬蘭語"] },
    { code: "no", aliases: ["Norwegian", "Norsk", "挪威语", "挪威語"] },
    { code: "el", aliases: ["Greek", "Ελληνικά", "希腊语", "希臘語"] },
    { code: "hu", aliases: ["Hungarian", "Magyar", "匈牙利语", "匈牙利語"] },
    { code: "ro", aliases: ["Romanian", "Română", "Romana", "罗马尼亚语", "羅馬尼亞語"] },
  ];

  for (const { code, aliases } of cases) {
    assert.equal(getLanguageCode(code), code);
    assert.equal(getLanguageCode(`${code}-XX`), code);
    for (const alias of aliases) {
      assert.equal(getLanguageCode(alias), code, alias);
    }
  }
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

test("never writes translated-only output back to the input subtitle", () => {
  assert.equal(
    getTranslatedPath(
      path.join("subtitles", "movie.en.srt"),
      "srt-translation",
      undefined,
      "movie.en.srt",
      "English"
    ),
    path.join("subtitles", "movie.translated.en.srt")
  );
  assert.equal(
    getTranslatedPath(
      path.join("subtitles", "movie.translated.en.srt"),
      "srt-translation",
      undefined,
      "movie.translated.en.srt",
      "English"
    ),
    path.join("subtitles", "movie.en.srt")
  );
});

test("removes only a generated suffix from irregular release filenames", () => {
  const sourceName =
    "Libertalia（Safia Benhaïm）.2025.1080p..translated.en.srt";
  const filePath = path.join("subtitles", sourceName);

  assert.equal(
    getTranslatedPath(
      filePath,
      "srt-translation",
      undefined,
      sourceName,
      "French",
      "English"
    ),
    path.join(
      "subtitles",
      "Libertalia（Safia Benhaïm）.2025.1080p.fr.srt"
    )
  );
  assert.equal(
    getTranslatedPath(
      filePath,
      "srt-bilingual",
      undefined,
      sourceName,
      "French",
      "English"
    ),
    path.join(
      "subtitles",
      "Libertalia（Safia Benhaïm）.2025.1080p.fr-en.srt"
    )
  );
});

test("removes a generated bilingual suffix without changing internal dots", () => {
  assert.equal(
    getTranslatedPath(
      path.join("subtitles", "Some.translated.story.2025.fr-en.srt"),
      "srt-original-translation",
      undefined,
      "Some.translated.story.2025.fr-en.srt",
      "Japanese",
      "English"
    ),
    path.join(
      "subtitles",
      "Some.translated.story.2025.en-ja.srt"
    )
  );
});

test("creates a reusable output identity without binding the output directory", () => {
  const identity = createTranslationOutputIdentity(
    path.join("subtitles", "movie.srt"),
    "srt-bilingual",
    "movie.srt",
    "English",
    "Chinese"
  );

  assert.deepEqual(identity, {
    format: "srt-bilingual",
    detectedSourceLanguage: "Chinese",
    fileName: "movie.en-zh.srt",
  });
  assert.equal(
    getTranslatedPathFromOutputIdentity(
      path.join("subtitles", "movie.srt"),
      path.join("other-output"),
      identity
    ),
    path.join("other-output", "movie.en-zh.srt")
  );
  assert.equal(
    getTranslatedPathFromOutputIdentity(
      path.join("subtitles", "movie.srt"),
      undefined,
      identity
    ),
    path.join("subtitles", "movie.en-zh.srt")
  );
});

test("reuses only safe output identities with the same output format", () => {
  const validIdentity = {
    format: "ass-bilingual" as const,
    detectedSourceLanguage: "Chinese",
    fileName: "movie.en-zh.ass",
  };

  assert.equal(isTranslationOutputIdentity(validIdentity), true);
  assert.equal(
    isReusableTranslationOutputIdentity(validIdentity, "ass-bilingual"),
    true
  );
  assert.equal(
    isReusableTranslationOutputIdentity(validIdentity, "srt-bilingual"),
    false
  );

  for (const unsafeIdentity of [
    { ...validIdentity, fileName: "" },
    { ...validIdentity, fileName: "." },
    { ...validIdentity, fileName: ".." },
    { ...validIdentity, fileName: "../movie.en-zh.ass" },
    { ...validIdentity, fileName: "folder/movie.en-zh.ass" },
    { ...validIdentity, fileName: "folder\\movie.en-zh.ass" },
    { ...validIdentity, fileName: path.resolve("movie.en-zh.ass") },
    { ...validIdentity, fileName: "movie.en-zh.srt" },
    { ...validIdentity, detectedSourceLanguage: 123 },
    { ...validIdentity, format: "unknown" },
  ]) {
    assert.equal(isTranslationOutputIdentity(unsafeIdentity), false);
  }
});

test("selects a stored output identity only for a compatible resume", () => {
  const identity = {
    format: "srt-bilingual" as const,
    detectedSourceLanguage: "Chinese",
    fileName: "movie.en-zh.srt",
  };

  assert.deepEqual(
    getReusableTranslationOutputIdentity({
      cachedIdentity: identity,
      outputFormat: "srt-bilingual",
      shouldRestartTranslation: false,
    }),
    identity
  );
  assert.equal(
    getReusableTranslationOutputIdentity({
      cachedIdentity: identity,
      outputFormat: "ass-bilingual",
      shouldRestartTranslation: false,
    }),
    undefined
  );
  assert.equal(
    getReusableTranslationOutputIdentity({
      cachedIdentity: identity,
      outputFormat: "srt-bilingual",
      shouldRestartTranslation: true,
    }),
    undefined
  );
  assert.equal(
    getReusableTranslationOutputIdentity({
      cachedIdentity: undefined,
      outputFormat: "srt-bilingual",
      shouldRestartTranslation: false,
    }),
    undefined
  );
});
