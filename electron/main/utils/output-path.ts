import path from "node:path";

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
  日语: "ja",
  日語: "ja",
  日本语: "ja",
  日本語: "ja",
  japanese: "ja",
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

export function getTargetLanguageCode(targetLanguage?: string): string | undefined {
  const normalized = targetLanguage
    ?.trim()
    .toLocaleLowerCase("en-US")
    .replaceAll(/[\s_()（）]+/g, "");
  if (!normalized) return undefined;

  const alias = languageAliases[normalized];
  if (alias) return alias;

  const localeMatch = normalized.match(/^([a-z]{2})(?:-[a-z]{2,4})?$/i);
  return localeMatch?.[1].toLowerCase();
}

export function getTranslatedPath(
  filePath: string,
  outputDirectory?: string,
  sourceName = path.basename(filePath),
  sourceExtension = path.extname(filePath).slice(1).toLowerCase(),
  targetLanguage?: string
): string {
  const basename = path.basename(sourceName, path.extname(sourceName));
  const languageCode = getTargetLanguageCode(targetLanguage) ?? "translated";
  return path.join(
    outputDirectory ?? path.dirname(filePath),
    `${basename}.${languageCode}.${sourceExtension}`
  );
}
