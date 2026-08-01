import path from "node:path";
import type { SubtitleOutputFormat } from "./subtitle-output";

const languageAliases: Record<string, string> = {
  english: "en",
  英语: "en",
  英語: "en",
  英文: "en",
  french: "fr",
  français: "fr",
  francais: "fr",
  法语: "fr",
  法語: "fr",
  japanese: "ja",
  日本语: "ja",
  日本語: "ja",
  日语: "ja",
  日語: "ja",
  german: "de",
  deutsch: "de",
  德语: "de",
  德語: "de",
  spanish: "es",
  español: "es",
  espanol: "es",
  西班牙语: "es",
  西班牙語: "es",
  italian: "it",
  italiano: "it",
  意大利语: "it",
  意大利語: "it",
  portuguese: "pt",
  português: "pt",
  portugues: "pt",
  葡萄牙语: "pt",
  葡萄牙語: "pt",
  korean: "ko",
  한국어: "ko",
  韩语: "ko",
  韓語: "ko",
  chinese: "zh",
  mandarin: "zh",
  mandarinchinese: "zh",
  simplifiedchinese: "zh",
  traditionalchinese: "zh",
  chinesesimplified: "zh",
  chinesetraditional: "zh",
  中文: "zh",
  汉语: "zh",
  漢語: "zh",
  简体中文: "zh",
  簡體中文: "zh",
  繁体中文: "zh",
  繁體中文: "zh",
  russian: "ru",
  русский: "ru",
  俄语: "ru",
  俄語: "ru",
  arabic: "ar",
  العربية: "ar",
  阿拉伯语: "ar",
  阿拉伯語: "ar",
};

const supportedLanguageCodes = new Set(Object.values(languageAliases));

function getComparablePath(filePath: string): string {
  const normalizedPath = path.resolve(filePath).normalize("NFC");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

function normalizeLanguage(value?: string): string | undefined {
  const normalized = value
    ?.trim()
    .toLocaleLowerCase("en-US")
    .replaceAll(/[\s_()（）]+/g, "");
  return normalized || undefined;
}

export function getLanguageCode(language?: string): string | undefined {
  const normalized = normalizeLanguage(language);
  if (!normalized) return undefined;

  const alias = languageAliases[normalized];
  if (alias) return alias;

  const localeMatch = normalized.match(/^([a-z]{2})(?:-[a-z]{2,4})?$/i);
  const code = localeMatch?.[1].toLowerCase();
  return code && supportedLanguageCodes.has(code) ? code : undefined;
}

function isGeneratedBilingualSuffix(value: string): boolean {
  const [first, second, ...rest] = value.split("-");
  return (
    rest.length === 0 &&
    Boolean(first) &&
    Boolean(second) &&
    (getLanguageCode(first) !== undefined ||
      first === "original" ||
      first === "translated") &&
    (getLanguageCode(second) !== undefined ||
      second === "original" ||
      second === "translated")
  );
}

function stripGeneratedSubtitleSuffix(sourceName: string): string {
  const extension = path.extname(sourceName);
  const basename = path.basename(sourceName, extension);
  const parts = basename.split(".");
  while (parts.at(-1) === "") parts.pop();

  const suffix = parts.at(-1)?.toLocaleLowerCase("en-US");
  if (!suffix) return basename;

  if (
    getLanguageCode(suffix) &&
    parts.at(-2)?.toLocaleLowerCase("en-US") === "translated"
  ) {
    parts.pop();
    parts.pop();
  } else if (
    getLanguageCode(suffix) ||
    suffix === "original" ||
    suffix === "translated" ||
    isGeneratedBilingualSuffix(suffix)
  ) {
    parts.pop();
  } else {
    return basename;
  }

  while (parts.at(-1) === "") parts.pop();
  return parts.join(".") || basename;
}

export function getSubtitleLanguageSuffix(
  outputFormat: SubtitleOutputFormat,
  targetLanguage?: string,
  detectedSourceLanguage?: string
): string {
  const targetCode = getLanguageCode(targetLanguage) ?? "translated";
  const sourceCode = getLanguageCode(detectedSourceLanguage) ?? "original";

  switch (outputFormat) {
    case "srt-translation":
      return targetCode;
    case "srt-bilingual":
    case "ass-bilingual":
      return `${targetCode}-${sourceCode}`;
    case "srt-original-translation":
    case "ass-original-translation":
      return `${sourceCode}-${targetCode}`;
  }
}

export function getTranslatedPath(
  filePath: string,
  outputFormat: SubtitleOutputFormat,
  outputDirectory?: string,
  sourceName = path.basename(filePath),
  targetLanguage?: string,
  detectedSourceLanguage?: string
): string {
  const basename = stripGeneratedSubtitleSuffix(sourceName);
  const suffix = getSubtitleLanguageSuffix(
    outputFormat,
    targetLanguage,
    detectedSourceLanguage
  );
  const extension = outputFormat.startsWith("ass-") ? "ass" : "srt";
  const outputPath = path.join(
    outputDirectory ?? path.dirname(filePath),
    `${basename}.${suffix}.${extension}`
  );

  if (
    outputFormat !== "srt-translation" ||
    getComparablePath(outputPath) !== getComparablePath(filePath)
  ) {
    return outputPath;
  }

  const safeSuffix =
    suffix === "translated" ? "translated.2" : `translated.${suffix}`;
  return path.join(
    outputDirectory ?? path.dirname(filePath),
    `${basename}.${safeSuffix}.${extension}`
  );
}
