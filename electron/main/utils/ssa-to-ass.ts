import assParser from "ass-parser";
import {
  createSsaToAssConversionError,
  type SsaToAssConversionErrorDetails,
} from "../../shared/ssa-to-ass-error";
import {
  addAssBilingualStyles,
  formatAssBilingualStyledText,
  type AssBilingualFontOptions,
} from "./ass-bilingual";

const SSA_STYLE_FIELDS = [
  "Name",
  "Fontname",
  "Fontsize",
  "PrimaryColour",
  "SecondaryColour",
  "TertiaryColour",
  "BackColour",
  "Bold",
  "Italic",
  "BorderStyle",
  "Outline",
  "Shadow",
  "Alignment",
  "MarginL",
  "MarginR",
  "MarginV",
  "AlphaLevel",
  "Encoding",
] as const;

const ASS_STYLE_FORMAT = [
  "Name",
  "Fontname",
  "Fontsize",
  "PrimaryColour",
  "SecondaryColour",
  "OutlineColour",
  "BackColour",
  "Bold",
  "Italic",
  "Underline",
  "StrikeOut",
  "ScaleX",
  "ScaleY",
  "Spacing",
  "Angle",
  "BorderStyle",
  "Outline",
  "Shadow",
  "Alignment",
  "MarginL",
  "MarginR",
  "MarginV",
  "Encoding",
] as const;

const ASS_EVENT_FORMAT = [
  "Layer",
  "Start",
  "End",
  "Style",
  "Name",
  "MarginL",
  "MarginR",
  "MarginV",
  "Effect",
  "Text",
] as const;

type AssStyle = Record<string, string>;

interface RawSection {
  name: string;
  header: string;
  lines: string[];
}

interface RawDocument {
  newline: string;
  preamble: string[];
  sections: RawSection[];
  endsWithNewline: boolean;
}

interface TranslationEvent {
  data: { translatedText?: string };
}

export interface ConvertSsaToBilingualAssOptions {
  sourceText: string;
  events: ReadonlyArray<TranslationEvent>;
  outputFormat: "ass-bilingual" | "ass-original-translation";
  fonts: AssBilingualFontOptions;
}

function conversionError(details: SsaToAssConversionErrorDetails): never {
  throw createSsaToAssConversionError(details);
}

function parseRawDocument(sourceText: string): RawDocument {
  if (sourceText.trim().length === 0) {
    conversionError({
      reason: "missing-source",
      location: "SSA source",
    });
  }
  const newline = sourceText.includes("\r\n") ? "\r\n" : "\n";
  const lines = sourceText.split(/\r\n|\n|\r/);
  const endsWithNewline = /(?:\r\n|\n|\r)$/.test(sourceText);
  if (endsWithNewline) lines.pop();

  const preamble: string[] = [];
  const sections: RawSection[] = [];
  let current: RawSection | undefined;
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1].trim(), header: line, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { newline, preamble, sections, endsWithNewline };
}

function findSection(document: RawDocument, name: string): RawSection {
  const section = document.sections.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase()
  );
  if (!section) {
    conversionError({
      reason: "missing-section",
      location: `[${name}]`,
    });
  }
  return section;
}

function parseDescriptor(line: string): { key: string; value: string } | undefined {
  const match = line.match(/^\s*([^;][^:]*)\s*:\s*(.*)$/);
  return match ? { key: match[1].trim(), value: match[2] } : undefined;
}

function splitFields(
  value: string,
  fieldCount: number,
  location: string
): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < fieldCount - 1; index += 1) {
    const comma = value.indexOf(",", start);
    if (comma < 0) {
      conversionError({ reason: "invalid-field", location, value });
    }
    fields.push(value.slice(start, comma).trim());
    start = comma + 1;
  }
  fields.push(value.slice(start).trim());
  return fields;
}

function recordFromFields(format: string[], fields: string[]): AssStyle {
  return Object.fromEntries(format.map((name, index) => [name, fields[index] ?? ""]));
}

function requireField(record: AssStyle, name: string, location: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    conversionError({
      reason: "invalid-field",
      location: `${location}.${name}`,
      value: value ?? "",
    });
  }
  return value.trim();
}

function requireFiniteNumber(
  record: AssStyle,
  name: string,
  location: string,
  minimum = 0
): string {
  const value = requireField(record, name, location);
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) {
    conversionError({
      reason: "invalid-field",
      location: `${location}.${name}`,
      value,
    });
  }
  return value;
}

function parseUnsignedColour(value: string, location: string): bigint {
  const normalized = value.trim();
  try {
    let parsed: bigint;
    const hex = normalized.match(/^&H([\dA-F]{1,8})&?$/i);
    if (hex) {
      parsed = BigInt(`0x${hex[1]}`);
    } else if (/^-?\d+$/.test(normalized)) {
      parsed = BigInt(normalized);
    } else {
      conversionError({ reason: "invalid-field", location, value });
    }
    return BigInt.asUintN(32, parsed!);
  } catch {
    conversionError({ reason: "invalid-field", location, value });
  }
}

function convertColour(
  value: string,
  alpha: number,
  location: string
): string {
  const colour = parseUnsignedColour(value, location) & 0xffffffn;
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${colour
    .toString(16)
    .padStart(6, "0")
    .toUpperCase()}`;
}

function convertAlignment(value: string, location: string): string {
  const alignmentMap = new Map([
    [1, 1],
    [2, 2],
    [3, 3],
    [5, 7],
    [6, 8],
    [7, 9],
    [9, 4],
    [10, 5],
    [11, 6],
  ]);
  const parsed = Number(value);
  const converted = Number.isInteger(parsed) ? alignmentMap.get(parsed) : undefined;
  if (converted === undefined) {
    conversionError({ reason: "invalid-field", location, value });
  }
  return String(converted);
}

function convertStyle(record: AssStyle): AssStyle {
  const name = requireField(record, "Name", "style");
  const location = `style ${name}`;
  for (const field of SSA_STYLE_FIELDS) requireField(record, field, location);
  requireFiniteNumber(record, "Fontsize", location, Number.EPSILON);
  requireFiniteNumber(record, "Outline", location);
  requireFiniteNumber(record, "Shadow", location);
  const alphaText = requireField(record, "AlphaLevel", location);
  const alpha = Number(alphaText);
  if (!Number.isInteger(alpha) || alpha < 0 || alpha > 255) {
    conversionError({
      reason: "invalid-field",
      location: `${location}.AlphaLevel`,
      value: alphaText,
    });
  }

  const result: AssStyle = {
    Name: name,
    Fontname: requireField(record, "Fontname", location),
    Fontsize: record.Fontsize,
    PrimaryColour: convertColour(
      record.PrimaryColour,
      alpha,
      `${location}.PrimaryColour`
    ),
    SecondaryColour: convertColour(
      record.SecondaryColour,
      alpha,
      `${location}.SecondaryColour`
    ),
    OutlineColour: convertColour(
      record.TertiaryColour,
      alpha,
      `${location}.TertiaryColour`
    ),
    BackColour: convertColour(record.BackColour, 0x80, `${location}.BackColour`),
    Bold: record.Bold,
    Italic: record.Italic,
    Underline: "0",
    StrikeOut: "0",
    ScaleX: "100",
    ScaleY: "100",
    Spacing: "0",
    Angle: "0",
    BorderStyle: record.BorderStyle,
    Outline: record.Outline,
    Shadow: record.Shadow,
    Alignment: convertAlignment(
      record.Alignment,
      `${location}.Alignment`
    ),
    MarginL: record.MarginL,
    MarginR: record.MarginR,
    MarginV: record.MarginV,
    Encoding: record.Encoding,
  };
  return result;
}

function convertStyles(section: RawSection, fonts: AssBilingualFontOptions) {
  let format: string[] | undefined;
  const sourceStyles: AssStyle[] = [];
  const preservedLines: string[] = [];
  for (const line of section.lines) {
    const descriptor = parseDescriptor(line);
    if (descriptor?.key.toLowerCase() === "format") {
      format = descriptor.value.split(",").map((field) => field.trim());
    } else if (descriptor?.key.toLowerCase() === "style") {
      if (!format) {
        conversionError({
          reason: "missing-format",
          location: "[V4 Styles]",
        });
      }
      sourceStyles.push(
        convertStyle(
          recordFromFields(
            format,
            splitFields(descriptor.value, format.length, "[V4 Styles].Style")
          )
        )
      );
    } else {
      preservedLines.push(line);
    }
  }
  if (!format) {
    conversionError({ reason: "missing-format", location: "[V4 Styles]" });
  }
  if (sourceStyles.length === 0) {
    conversionError({ reason: "missing-style", location: "[V4 Styles]" });
  }

  const body = [
    { key: "Format", value: [...ASS_STYLE_FORMAT] },
    ...sourceStyles.map((value) => ({ key: "Style", value })),
  ];
  const { full, stylesBySource } = addAssBilingualStyles(
    [{ section: "V4+ Styles", body }],
    fonts
  );
  const styledBody = full[0].body ?? [];
  const styleLines = styledBody
    .filter(
      (line) =>
        line.key === "Style" &&
        typeof line.value === "object" &&
        line.value !== null &&
        !Array.isArray(line.value)
    )
    .map(
      (line) =>
        `Style: ${ASS_STYLE_FORMAT.map(
          (field) => (line.value as AssStyle)[field] ?? ""
        ).join(",")}`
    );

  return {
    lines: [
      ...preservedLines,
      `Format: ${ASS_STYLE_FORMAT.join(", ")}`,
      ...styleLines,
    ],
    stylesBySource,
    sourceStyleNames: new Set(sourceStyles.map((style) => style.Name)),
  };
}

function convertScriptInfo(section: RawSection): string[] {
  let found = false;
  const lines = section.lines.map((line) => {
    const descriptor = parseDescriptor(line);
    if (descriptor?.key.toLowerCase() !== "scripttype") return line;
    found = true;
    return "ScriptType: v4.00+";
  });
  if (!found) lines.push("ScriptType: v4.00+");
  return lines;
}

function convertEvents({
  section,
  events,
  outputFormat,
  stylesBySource,
  sourceStyleNames,
}: {
  section: RawSection;
  events: ReadonlyArray<TranslationEvent>;
  outputFormat: "ass-bilingual" | "ass-original-translation";
  stylesBySource: ReturnType<typeof convertStyles>["stylesBySource"];
  sourceStyleNames: Set<string>;
}): { lines: string[]; dialogueCount: number } {
  let format: string[] | undefined;
  let dialogueIndex = 0;
  const lines: string[] = [];
  for (const line of section.lines) {
    const descriptor = parseDescriptor(line);
    if (descriptor?.key.toLowerCase() === "format") {
      format = descriptor.value.split(",").map((field) => field.trim());
      if (format.at(-1)?.toLowerCase() !== "text") {
        conversionError({
          reason: "invalid-field",
          location: "[Events].Format.Text",
          value: descriptor.value,
        });
      }
      lines.push(`Format: ${ASS_EVENT_FORMAT.join(", ")}`);
      continue;
    }
    if (!descriptor) {
      lines.push(line);
      continue;
    }
    const eventKey = descriptor.key.toLowerCase();
    if (eventKey !== "dialogue" && eventKey !== "comment") {
      lines.push(line);
      continue;
    }
    if (!format) {
      conversionError({ reason: "missing-format", location: "[Events]" });
    }
    const source = recordFromFields(
      format,
      splitFields(descriptor.value, format.length, `[Events].${descriptor.key}`)
    );
    const styleName = requireField(source, "Style", `[Events].${descriptor.key}`);
    if (!sourceStyleNames.has(styleName.replace(/^\*/, ""))) {
      conversionError({
        reason: "missing-style",
        location: `[Events].${descriptor.key}.Style`,
        value: styleName,
      });
    }
    const output: AssStyle = {
      Layer: "0",
      Start: requireField(source, "Start", `[Events].${descriptor.key}`),
      End: requireField(source, "End", `[Events].${descriptor.key}`),
      Style: styleName,
      Name: source.Name ?? "",
      MarginL: source.MarginL ?? "0000",
      MarginR: source.MarginR ?? "0000",
      MarginV: source.MarginV ?? "0000",
      Effect: source.Effect ?? "",
      Text: source.Text ?? "",
    };
    if (eventKey === "dialogue") {
      const event = events[dialogueIndex];
      if (!event) {
        conversionError({
          reason: "invalid-output",
          location: `[Events].Dialogue ${dialogueIndex + 1}`,
        });
      }
      const styleNames =
        stylesBySource.get(styleName) ??
        stylesBySource.get(styleName.replace(/^\*/, ""));
      if (!styleNames) {
        conversionError({
          reason: "missing-style",
          location: `[Events].Dialogue ${dialogueIndex + 1}.Style`,
          value: styleName,
        });
      }
      output.Text = formatAssBilingualStyledText({
        originalText: output.Text,
        translatedText: event.data.translatedText,
        order:
          outputFormat === "ass-original-translation"
            ? "original+translate"
            : "translate+original",
        translationStyle: styleNames.translation,
        originalStyle: styleNames.original,
      });
      dialogueIndex += 1;
    }
    lines.push(
      `${descriptor.key}: ${ASS_EVENT_FORMAT.map((field) => output[field]).join(",")}`
    );
  }
  if (!format) {
    conversionError({ reason: "missing-format", location: "[Events]" });
  }
  if (dialogueIndex !== events.length) {
    conversionError({
      reason: "invalid-output",
      location: "[Events].Dialogue count",
      value: `${dialogueIndex}/${events.length}`,
    });
  }
  return { lines, dialogueCount: dialogueIndex };
}

function validateGeneratedAss(
  output: string,
  expectedDialogueCount: number,
  sourceStyleNames: Set<string>
): void {
  try {
    const parsed = assParser(output) as Array<{
      section?: string;
      body?: Array<{ key?: string; value?: unknown }>;
    }>;
    const styles = parsed.find((section) => section.section === "V4+ Styles");
    const events = parsed.find((section) => section.section === "Events");
    const styleNames = new Set(
      (styles?.body ?? []).flatMap((line) => {
        const value = line.value;
        return line.key === "Style" &&
          typeof value === "object" &&
          value !== null &&
          typeof (value as AssStyle).Name === "string"
          ? [(value as AssStyle).Name]
          : [];
      })
    );
    const dialogues = (events?.body ?? []).filter(
      (line) => line.key?.toLowerCase() === "dialogue"
    );
    if (
      !styles ||
      !events ||
      styleNames.size < sourceStyleNames.size ||
      dialogues.length !== expectedDialogueCount ||
      [...sourceStyleNames].some((name) => !styleNames.has(name))
    ) {
      conversionError({
        reason: "invalid-output",
        location: "generated ASS structure",
      });
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("ERR_SSA_TO_ASS_CONVERSION:")
    ) {
      throw error;
    }
    conversionError({
      reason: "invalid-output",
      location: "generated ASS parser",
    });
  }
}

export function convertSsaToBilingualAss({
  sourceText,
  events,
  outputFormat,
  fonts,
}: ConvertSsaToBilingualAssOptions): string {
  const document = parseRawDocument(sourceText);
  const scriptInfo = findSection(document, "Script Info");
  const styles = findSection(document, "V4 Styles");
  const eventSection = findSection(document, "Events");
  const convertedStyles = convertStyles(styles, fonts);
  const convertedEvents = convertEvents({
    section: eventSection,
    events,
    outputFormat,
    stylesBySource: convertedStyles.stylesBySource,
    sourceStyleNames: convertedStyles.sourceStyleNames,
  });

  const outputLines = [...document.preamble];
  for (const section of document.sections) {
    if (section === scriptInfo) {
      outputLines.push(section.header, ...convertScriptInfo(section));
    } else if (section === styles) {
      outputLines.push("[V4+ Styles]", ...convertedStyles.lines);
    } else if (section === eventSection) {
      outputLines.push(section.header, ...convertedEvents.lines);
    } else {
      outputLines.push(section.header, ...section.lines);
    }
  }
  let output = outputLines.join(document.newline);
  if (document.endsWithNewline) output += document.newline;
  validateGeneratedAss(
    output,
    convertedEvents.dialogueCount,
    convertedStyles.sourceStyleNames
  );
  return output;
}

export function validateSsaToAssSource(sourceText: string): void {
  const document = parseRawDocument(sourceText);
  const events = findSection(document, "Events");
  let dialogueCount = 0;
  for (const line of events.lines) {
    if (parseDescriptor(line)?.key.toLowerCase() === "dialogue") {
      dialogueCount += 1;
    }
  }
  convertSsaToBilingualAss({
    sourceText,
    events: Array.from({ length: dialogueCount }, () => ({ data: {} })),
    outputFormat: "ass-bilingual",
    fonts: {},
  });
}
