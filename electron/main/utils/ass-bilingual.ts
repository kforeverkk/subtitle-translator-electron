export interface AssBilingualFontOptions {
  translationFont?: string;
  originalFont?: string;
}

export type AssBilingualOrder =
  | "translate+original"
  | "original+translate";

export interface AssStyleDescriptor {
  key?: string;
  value?: Record<string, string> | string | string[];
  [key: string]: unknown;
}

export interface AssStyleSection {
  section?: string;
  body?: AssStyleDescriptor[];
  [key: string]: unknown;
}

export interface AssBilingualStylePair {
  translation: string;
  original: string;
}

const DEFAULT_ASS_FONT_SIZE = 20;
const ORIGINAL_FONT_SCALE = 0.6;
const INVALID_ASS_FONT_CHARACTERS = /[,{}\\\r\n]/;

export function normalizeAssFontName(value: string | undefined): string {
  const fontName = value?.trim() ?? "";
  if (
    fontName.length === 0 ||
    fontName.length > 100 ||
    INVALID_ASS_FONT_CHARACTERS.test(fontName)
  ) {
    return "";
  }
  return fontName;
}

export function getSmallerAssFontSize(baseFontSize: unknown): number {
  const parsedFontSize =
    typeof baseFontSize === "string" || typeof baseFontSize === "number"
      ? Number(baseFontSize)
      : Number.NaN;
  const safeFontSize =
    Number.isFinite(parsedFontSize) && parsedFontSize > 0
      ? parsedFontSize
      : DEFAULT_ASS_FONT_SIZE;
  return Math.max(1, Math.round(safeFontSize * ORIGINAL_FONT_SCALE));
}

export function addAssBilingualStyles<T extends AssStyleSection>(
  full: T[],
  fonts: AssBilingualFontOptions
): {
  full: T[];
  stylesBySource: Map<string, AssBilingualStylePair>;
} {
  const usedNames = new Set<string>();
  for (const section of full) {
    for (const line of section.body ?? []) {
      if (
        line.key === "Style" &&
        typeof line.value === "object" &&
        line.value !== null &&
        !Array.isArray(line.value) &&
        typeof line.value.Name === "string"
      ) {
        usedNames.add(line.value.Name);
      }
    }
  }

  const createUniqueName = (baseName: string): string => {
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name)) name = `${baseName} ${suffix++}`;
    usedNames.add(name);
    return name;
  };
  const translationFont = normalizeAssFontName(fonts.translationFont);
  const originalFont = normalizeAssFontName(fonts.originalFont);
  const stylesBySource = new Map<string, AssBilingualStylePair>();
  let styleIndex = 0;

  const styledFull = full.map((section) => {
    if (section.section !== "V4+ Styles" || !section.body) return section;
    const generatedStyles: AssStyleDescriptor[] = [];
    for (const line of section.body) {
      if (
        line.key !== "Style" ||
        typeof line.value !== "object" ||
        line.value === null ||
        Array.isArray(line.value) ||
        typeof line.value.Name !== "string"
      ) {
        continue;
      }

      const sourceStyle = line.value;
      const styleNames = {
        translation: createUniqueName(`ST Translation ${styleIndex}`),
        original: createUniqueName(`ST Original ${styleIndex}`),
      };
      styleIndex += 1;
      stylesBySource.set(sourceStyle.Name, styleNames);
      stylesBySource.set(`*${sourceStyle.Name}`, styleNames);
      generatedStyles.push(
        {
          key: "Style",
          value: {
            ...sourceStyle,
            Name: styleNames.translation,
            ...(translationFont ? { Fontname: translationFont } : {}),
          },
        },
        {
          key: "Style",
          value: {
            ...sourceStyle,
            Name: styleNames.original,
            ...(originalFont ? { Fontname: originalFont } : {}),
            Fontsize: String(getSmallerAssFontSize(sourceStyle.Fontsize)),
            PrimaryColour: "&H00FFFFFF",
            OutlineColour: "&H002F2F2F",
            BackColour: "&H00000000",
            Bold: "0",
          },
        }
      );
    }
    return {
      ...section,
      body: [...section.body, ...generatedStyles],
    };
  }) as T[];

  return { full: styledFull, stylesBySource };
}

export function formatAssBilingualStyledText({
  originalText,
  translatedText,
  order,
  translationStyle,
  originalStyle,
}: {
  originalText: string;
  translatedText: string;
  order: AssBilingualOrder;
  translationStyle: string;
  originalStyle: string;
}): string {
  const translated = `{\\r${translationStyle}}${translatedText.replace(/\r\n|\r|\n/g, "\\N")}`;
  const original = `{\\r${originalStyle}}${originalText.replace(/\r\n|\r|\n/g, "\\N")}`;
  return order === "translate+original"
    ? `${translated}\\N${original}`
    : `${original}\\N${translated}`;
}
