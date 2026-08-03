export const subtitleOutputFormats = [
  "srt-translation",
  "srt-bilingual",
  "srt-original-translation",
  "ass-bilingual",
  "ass-original-translation",
] as const;

export type SubtitleOutputFormat = (typeof subtitleOutputFormats)[number];
export type SubtitleOutputExtension = "srt" | "ass";

const ASS_STYLE_FORMAT = [
  "Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour",
  "OutlineColour", "BackColour", "Bold", "Italic", "Underline",
  "StrikeOut", "ScaleX", "ScaleY", "Spacing", "Angle", "BorderStyle",
  "Outline", "Shadow", "Alignment", "MarginL", "MarginR", "MarginV",
  "Encoding",
];
const ASS_EVENT_FORMAT = [
  "Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR",
  "MarginV", "Effect", "Text",
];

export function getSubtitleOutputExtension(
  outputFormat: SubtitleOutputFormat
): SubtitleOutputExtension {
  return outputFormat.startsWith("ass-") ? "ass" : "srt";
}

export function getSubtitleOutputFileSuffix(
  outputFormat: SubtitleOutputFormat
): string {
  switch (outputFormat) {
    case "srt-translation":
      return "translated.srt";
    case "srt-bilingual":
      return "bilingual.srt";
    case "srt-original-translation":
      return "bilingual.original-translated.srt";
    case "ass-bilingual":
      return "bilingual.ass";
    case "ass-original-translation":
      return "bilingual.original-translated.ass";
  }
}

export function isBilingualOutput(outputFormat: SubtitleOutputFormat): boolean {
  return outputFormat !== "srt-translation";
}

function hasTranslationText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function formatSrtOutputText({
  originalText,
  translatedText,
  outputFormat,
}: {
  originalText: string;
  translatedText?: string;
  outputFormat:
    | "srt-translation"
    | "srt-bilingual"
    | "srt-original-translation";
}): string {
  if (!hasTranslationText(translatedText)) return originalText;

  switch (outputFormat) {
    case "srt-translation":
      return translatedText;
    case "srt-bilingual":
      return `${translatedText}\n${originalText}`;
    case "srt-original-translation":
      return `${originalText}\n${translatedText}`;
  }
}

export function subtitleTimestampToMilliseconds(value: number | string): number {
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0) return value;
    throw new RangeError(`Invalid subtitle timestamp: ${value}`);
  }

  const match = value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!match) throw new RangeError(`Invalid subtitle timestamp: ${value}`);
  const [, hours, minutes, seconds, fraction] = match;
  const milliseconds = Number(fraction.padEnd(3, "0"));
  if (Number(minutes) >= 60 || Number(seconds) >= 60) {
    throw new RangeError(`Invalid subtitle timestamp: ${value}`);
  }
  return (
    (Number(hours) * 60 * 60 + Number(minutes) * 60 + Number(seconds)) *
      1000 +
    milliseconds
  );
}

export function millisecondsToAssTimestamp(value: number | string): string {
  const totalCentiseconds = Math.max(
    0,
    Math.round(subtitleTimestampToMilliseconds(value) / 10)
  );
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

export function assTextToPlainText(value: string): string {
  let drawingMode = false;
  let result = "";
  let cursor = 0;
  const overrideBlock = /\{([^{}]*)\}/g;

  for (const match of value.matchAll(overrideBlock)) {
    const index = match.index ?? 0;
    if (!drawingMode) result += value.slice(cursor, index);
    const tags = match[1];
    if (/\\p[1-9]\d*/i.test(tags)) drawingMode = true;
    if (/\\p0/i.test(tags)) drawingMode = false;
    cursor = index + match[0].length;
  }
  if (!drawingMode) result += value.slice(cursor);

  return result
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

export function createDefaultAssSections(
  cues: ReadonlyArray<{
    data: { text: string; start: number | string; end: number | string };
  }>
) {
  return [
    {
      section: "Script Info",
      body: [
        { key: "ScriptType", value: "v4.00+" },
        { key: "Collisions", value: "Normal" },
        { key: "PlayResX", value: "384" },
        { key: "PlayResY", value: "288" },
        { key: "Timer", value: "100.0000" },
        { key: "WrapStyle", value: "0" },
        { key: "ScaledBorderAndShadow", value: "no" },
      ],
    },
    {
      section: "V4+ Styles",
      body: [
        { key: "Format", value: ASS_STYLE_FORMAT },
        {
          key: "Style",
          value: {
            Name: "Default",
            Fontname: "Arial",
            Fontsize: "20",
            PrimaryColour: "&H00FFFFFF",
            SecondaryColour: "&H00000000",
            OutlineColour: "&H00000000",
            BackColour: "&H00000000",
            Bold: "0",
            Italic: "0",
            Underline: "0",
            StrikeOut: "0",
            ScaleX: "100",
            ScaleY: "100",
            Spacing: "0",
            Angle: "0",
            BorderStyle: "1",
            Outline: "1",
            Shadow: "1",
            Alignment: "2",
            MarginL: "5",
            MarginR: "5",
            MarginV: "5",
            Encoding: "1",
          },
        },
      ],
    },
    {
      section: "Events",
      body: [
        { key: "Format", value: ASS_EVENT_FORMAT },
        ...cues.map((cue) => ({
          key: "Dialogue",
          value: {
            Layer: "0",
            Start: millisecondsToAssTimestamp(cue.data.start),
            End: millisecondsToAssTimestamp(cue.data.end),
            Style: "Default",
            Name: "",
            MarginL: "0000",
            MarginR: "0000",
            MarginV: "0000",
            Effect: "",
            Text: cue.data.text,
          },
        })),
      ],
    },
  ];
}
