import path from "node:path";
import {
  getSubtitleOutputExtension,
  subtitleOutputFormats,
  type SubtitleOutputFormat,
} from "./subtitle-output";

export interface TranslationOutputIdentity {
  format: SubtitleOutputFormat;
  detectedSourceLanguage: string;
  fileName: string;
}

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
  dutch: "nl",
  nederlands: "nl",
  荷兰语: "nl",
  荷蘭語: "nl",
  polish: "pl",
  polski: "pl",
  波兰语: "pl",
  波蘭語: "pl",
  turkish: "tr",
  türkçe: "tr",
  turkce: "tr",
  土耳其语: "tr",
  土耳其語: "tr",
  vietnamese: "vi",
  tiếngviệt: "vi",
  tiengviet: "vi",
  越南语: "vi",
  越南語: "vi",
  thai: "th",
  ไทย: "th",
  泰语: "th",
  泰語: "th",
  indonesian: "id",
  bahasaindonesia: "id",
  印度尼西亚语: "id",
  印度尼西亞語: "id",
  印尼语: "id",
  印尼語: "id",
  in: "id",
  ukrainian: "uk",
  українська: "uk",
  乌克兰语: "uk",
  烏克蘭語: "uk",
  hebrew: "he",
  עברית: "he",
  希伯来语: "he",
  希伯來語: "he",
  iw: "he",
  czech: "cs",
  čeština: "cs",
  cestina: "cs",
  捷克语: "cs",
  捷克語: "cs",
  swedish: "sv",
  svenska: "sv",
  瑞典语: "sv",
  瑞典語: "sv",
  danish: "da",
  dansk: "da",
  丹麦语: "da",
  丹麥語: "da",
  finnish: "fi",
  suomi: "fi",
  芬兰语: "fi",
  芬蘭語: "fi",
  norwegian: "no",
  norsk: "no",
  挪威语: "no",
  挪威語: "no",
  greek: "el",
  ελληνικά: "el",
  希腊语: "el",
  希臘語: "el",
  hungarian: "hu",
  magyar: "hu",
  匈牙利语: "hu",
  匈牙利語: "hu",
  romanian: "ro",
  română: "ro",
  romana: "ro",
  罗马尼亚语: "ro",
  羅馬尼亞語: "ro",
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

function isSubtitleOutputFormat(value: unknown): value is SubtitleOutputFormat {
  return (
    typeof value === "string" &&
    subtitleOutputFormats.includes(value as SubtitleOutputFormat)
  );
}

function isSafeOutputFileName(
  fileName: unknown,
  outputFormat: SubtitleOutputFormat
): fileName is string {
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("\0") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    path.isAbsolute(fileName) ||
    path.win32.isAbsolute(fileName) ||
    path.posix.isAbsolute(fileName)
  ) {
    return false;
  }

  return (
    path.extname(fileName).toLocaleLowerCase("en-US") ===
    `.${getSubtitleOutputExtension(outputFormat)}`
  );
}

export function isTranslationOutputIdentity(
  value: unknown
): value is TranslationOutputIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isSubtitleOutputFormat(candidate.format) &&
    typeof candidate.detectedSourceLanguage === "string" &&
    isSafeOutputFileName(candidate.fileName, candidate.format)
  );
}

export function isReusableTranslationOutputIdentity(
  value: unknown,
  outputFormat: SubtitleOutputFormat
): value is TranslationOutputIdentity {
  return isTranslationOutputIdentity(value) && value.format === outputFormat;
}

export function getReusableTranslationOutputIdentity({
  cachedIdentity,
  outputFormat,
  shouldRestartTranslation,
}: {
  cachedIdentity: unknown;
  outputFormat: SubtitleOutputFormat;
  shouldRestartTranslation: boolean;
}): TranslationOutputIdentity | undefined {
  return !shouldRestartTranslation &&
    isReusableTranslationOutputIdentity(cachedIdentity, outputFormat)
    ? cachedIdentity
    : undefined;
}

export function createTranslationOutputIdentity(
  filePath: string,
  outputFormat: SubtitleOutputFormat,
  sourceName = path.basename(filePath),
  targetLanguage?: string,
  detectedSourceLanguage = ""
): TranslationOutputIdentity {
  const outputPath = getTranslatedPath(
    filePath,
    outputFormat,
    undefined,
    sourceName,
    targetLanguage,
    detectedSourceLanguage
  );
  return {
    format: outputFormat,
    detectedSourceLanguage,
    fileName: path.basename(outputPath),
  };
}

export function getTranslatedPathFromOutputIdentity(
  filePath: string,
  outputDirectory: string | undefined,
  identity: TranslationOutputIdentity
): string {
  if (!isTranslationOutputIdentity(identity)) {
    throw new Error("Invalid translation output identity");
  }
  return path.join(
    outputDirectory ?? path.dirname(filePath),
    identity.fileName
  );
}

export function getSafeTranslationOutputIdentity({
  filePath,
  outputDirectory,
  sourceName = path.basename(filePath),
  targetLanguage,
  identity,
}: {
  filePath: string;
  outputDirectory?: string;
  sourceName?: string;
  targetLanguage?: string;
  identity: TranslationOutputIdentity;
}): TranslationOutputIdentity {
  const outputPath = getTranslatedPathFromOutputIdentity(
    filePath,
    outputDirectory,
    identity
  );
  if (getComparablePath(outputPath) !== getComparablePath(filePath)) {
    return identity;
  }

  if (identity.format === "srt-translation") {
    return {
      ...identity,
      fileName: path.basename(
        getTranslatedPath(
          filePath,
          identity.format,
          outputDirectory,
          sourceName,
          targetLanguage,
          identity.detectedSourceLanguage
        )
      ),
    };
  }

  const sourceExtension = path.extname(sourceName);
  const sourceBasename = path.basename(sourceName, sourceExtension);
  const suffix = getSubtitleLanguageSuffix(
    identity.format,
    targetLanguage,
    identity.detectedSourceLanguage
  );
  return {
    ...identity,
    fileName: `${sourceBasename}.${suffix}.${getSubtitleOutputExtension(
      identity.format
    )}`,
  };
}
