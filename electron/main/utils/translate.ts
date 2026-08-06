import fs from "node:fs";
import path from "node:path";
import { parseSync, stringifySync, type NodeList } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";
import {
  APICallError,
  generateText,
  NoOutputGeneratedError,
  Output,
  streamText,
} from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { translationErrorCodes } from "../../shared/translation-error-codes";
import { getFirstValidApiKey } from "./api-account";
import type { RequestRateLimiter } from "./request-rate-limiter";
import {
  compactRepetitiveSubtitleText,
  hasSubtitleTranslationText,
} from "./subtitle-chunks";
import { sampleSubtitlesForAnalysis } from "./subtitle-sampling";
import {
  isTranslationTaskId,
  type TranslationSourceFingerprint,
} from "./translation-checkpoint";
import {
  formatSubtitleAnalysis,
  subtitleAnalysisSchema,
} from "./analysis-output";
import {
  isCompletedModelFinishReason,
  parseTranslationOutput,
  TranslationOutputRepetitionGuard,
  validateTranslationOutputForCore,
} from "./translation-output";
import {
  addAssBilingualStyles,
  formatAssBilingualStyledText,
  type AssBilingualFontOptions,
} from "./ass-bilingual";
import {
  assTextToPlainText,
  createDefaultAssSections,
  formatSrtOutputText,
  subtitleTimestampToMilliseconds,
  type SubtitleOutputFormat,
} from "./subtitle-output";
import { createSsaToAssConversionError } from "../../shared/ssa-to-ass-error";
import {
  decodeSubtitleBuffer,
  readSubtitleFile,
} from "./subtitle-encoding";
import { createSubtitleSourceFingerprint } from "./subtitle-source-identity";
import {
  convertSsaToBilingualAss,
} from "./ssa-to-ass";
import {
  isTranslationOutputIdentity,
  type TranslationOutputIdentity,
} from "./output-path";

export interface SubtitleCueData {
  text: string;
  start: number | string;
  end: number | string;
  translatedText?: string;
}

export interface SubtitleCue {
  type: "cue";
  data: SubtitleCueData;
}

export type SubtitleFileExtension = "ass" | "ssa" | "srt" | "vtt";

interface SubtitleHeader {
  type: "header";
  data: string;
}

interface AssDescriptor {
  key?: string;
  type?: string;
  value?: Record<string, string> | string | string[];
  [key: string]: unknown;
}

interface AssSection {
  section?: string;
  body?: AssDescriptor[];
  [key: string]: unknown;
}

export interface AssSubtitle {
  full: AssSection[];
  events: SubtitleCue[];
  source?: {
    format: "ssa";
    text: string;
  };
}

export type ParsedSubtitle = Array<SubtitleCue | SubtitleHeader> | AssSubtitle;
export interface SubtitleTranslationChunk {
  before: string[];
  core: string[];
  after: string[];
}

export interface TranslationCacheDocument {
  version: 1 | 2 | 3;
  format: SubtitleFileExtension;
  source: {
    name: string;
    fingerprint?: TranslationSourceFingerprint;
  };
  translation?: {
    configFingerprint: string;
  };
  task?: {
    id: string;
  };
  output?: TranslationOutputIdentity;
  subtitle: ParsedSubtitle;
  analysis?: string;
}

function isCue(node: SubtitleCue | SubtitleHeader): node is SubtitleCue {
  return node.type === "cue";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSubtitleFileExtension(value: unknown): value is SubtitleFileExtension {
  return value === "ass" || value === "ssa" || value === "srt" || value === "vtt";
}

function isSourceFingerprint(
  value: unknown
): value is TranslationSourceFingerprint {
  if (
    !(
    isRecord(value) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.mtimeMs === "number" &&
    Number.isFinite(value.mtimeMs) &&
    value.mtimeMs >= 0
    )
  ) {
    return false;
  }

  const hashFields = [
    value.rawHash,
    value.contentHash,
    value.contentHashVersion,
  ];
  const hasAnyHashField = hashFields.some((field) => field !== undefined);
  if (!hasAnyHashField) return true;

  return (
    typeof value.rawHash === "string" &&
    /^[a-f\d]{64}$/i.test(value.rawHash) &&
    typeof value.contentHash === "string" &&
    /^[a-f\d]{64}$/i.test(value.contentHash) &&
    typeof value.contentHashVersion === "number" &&
    Number.isSafeInteger(value.contentHashVersion) &&
    value.contentHashVersion >= 1
  );
}

function isSubtitleCueData(value: unknown): value is SubtitleCueData {
  if (!isRecord(value)) return false;
  if (typeof value.text !== "string") return false;
  if (typeof value.start !== "number" && typeof value.start !== "string") return false;
  if (typeof value.end !== "number" && typeof value.end !== "string") return false;
  return value.translatedText === undefined || typeof value.translatedText === "string";
}

function isSubtitleCueNode(value: unknown): value is SubtitleCue {
  return (
    isRecord(value) &&
    value.type === "cue" &&
    isSubtitleCueData(value.data)
  );
}

function isParsedSubtitle(value: unknown): value is ParsedSubtitle {
  if (Array.isArray(value)) {
    return value.every((node) => {
      if (isSubtitleCueNode(node)) return true;
      return (
        isRecord(node) &&
        node.type === "header" &&
        typeof node.data === "string"
      );
    });
  }

  return (
    isRecord(value) &&
    Array.isArray(value.full) &&
    value.full.every(isRecord) &&
    Array.isArray(value.events) &&
    value.events.every(isSubtitleCueNode) &&
    (value.source === undefined ||
      (isRecord(value.source) &&
        value.source.format === "ssa" &&
        typeof value.source.text === "string" &&
        value.source.text.trim().length > 0))
  );
}

export function createTranslationCacheDocument({
  subtitle,
  sourceName,
  format,
  configFingerprint,
  taskId,
  output,
  analysis,
  sourceFingerprint,
}: {
  subtitle: ParsedSubtitle;
  sourceName: string;
  format: SubtitleFileExtension;
  configFingerprint: string;
  taskId: string;
  output?: TranslationOutputIdentity;
  analysis?: string;
  sourceFingerprint?: TranslationSourceFingerprint;
}): TranslationCacheDocument {
  return {
    version: 3,
    format,
    source: {
      name: sourceName,
      ...(sourceFingerprint ? { fingerprint: sourceFingerprint } : {}),
    },
    translation: { configFingerprint },
    task: { id: taskId },
    ...(output ? { output } : {}),
    subtitle,
    ...(analysis ? { analysis } : {}),
  };
}

export function parseTranslationCache(
  content: string
): TranslationCacheDocument {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error(translationErrorCodes.invalidCheckpoint);
  }

  if (!isRecord(value)) {
    throw new Error(translationErrorCodes.invalidCheckpoint);
  }

  const source = value.source;
  if (
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !isSubtitleFileExtension(value.format) ||
    !isRecord(source) ||
    typeof source.name !== "string" ||
    source.name.trim().length === 0 ||
    (source.fingerprint !== undefined &&
      !isSourceFingerprint(source.fingerprint)) ||
    ((value.version === 2 || value.version === 3) &&
      (!isRecord(value.translation) ||
        typeof value.translation.configFingerprint !== "string" ||
        !/^[a-f\d]{64}$/i.test(value.translation.configFingerprint))) ||
    (value.version === 1 &&
      (value.translation !== undefined || value.task !== undefined)) ||
    (value.version === 2 && value.task !== undefined) ||
    (value.version === 3 &&
      (!isRecord(value.task) || !isTranslationTaskId(value.task.id))) ||
    (value.output !== undefined &&
      !isTranslationOutputIdentity(value.output)) ||
    !isParsedSubtitle(value.subtitle) ||
    getSubtitleCues(value.subtitle).length === 0 ||
    (value.analysis !== undefined && typeof value.analysis !== "string")
  ) {
    throw new Error(translationErrorCodes.incompatibleCheckpoint);
  }

  return value as unknown as TranslationCacheDocument;
}

export function getSubtitleCues(parsedSubtitle: ParsedSubtitle): SubtitleCue[] {
  return Array.isArray(parsedSubtitle)
    ? parsedSubtitle.filter(isCue)
    : parsedSubtitle.events;
}

function getAi({ apiKey, apiHost }: { apiKey: string; apiHost: string }) {
  return createOpenAICompatible({
    name: "openai",
    apiKey: apiKey,
    baseURL: apiHost,
    headers: {
      // OpenRouter Headers
      "HTTP-Referer": "https://github.com/kforeverkk/subtitle-translator-electron",
      "X-Title": "Subtitle Translator",
    },
  });
}

async function translateSubtitleChunk(
  { before, core, after }: SubtitleTranslationChunk,
  {
    apiKeys,
    apiHost,
    model,
    prompt,
    lang,
    additional,
    temperature,
    requestRateLimiter,
    abortSignal,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    prompt: string;
    lang: string;
    additional: string;
    temperature: number;
    requestRateLimiter?: RequestRateLimiter;
    abortSignal?: AbortSignal;
  }
) {
  if (core.length === 0) return [];

  const compactedBefore = before.map(compactRepetitiveSubtitleText);
  const compactedCore = core.map(compactRepetitiveSubtitleText);
  const compactedAfter = after.map(compactRepetitiveSubtitleText);

  const ai = getAi({ apiKey: getFirstValidApiKey(apiKeys), apiHost });

  const systemPrompt = prompt
    .replaceAll("{{lang}}", lang)
    .replaceAll("{{additional}}", additional);

  const repetitionController = new AbortController();
  const requestAbortSignal = abortSignal
    ? AbortSignal.any([abortSignal, repetitionController.signal])
    : repetitionController.signal;

  const translationOutput = Output.json();

  const runTranslationRequest = async (requestPrompt: string) => {
    await requestRateLimiter?.waitForSlot(abortSignal);
    const repetitionGuards = new Map<
      string,
      TranslationOutputRepetitionGuard
    >();
    let stoppedForRepetition = false;
    let recordedStreamError: unknown;

    const result = streamText({
      model: ai(model),
      temperature,
      system: systemPrompt,
      output: translationOutput,
      prompt: requestPrompt,
      maxRetries: 0,
      abortSignal: requestAbortSignal,
      onError({ error }) {
        recordedStreamError = error;
      },
      onChunk({ chunk }) {
        if (
          chunk.type !== "text-delta" &&
          chunk.type !== "reasoning-delta"
        ) {
          return;
        }

        const guardKey = `${chunk.type}:${chunk.id}`;
        const guard =
          repetitionGuards.get(guardKey) ??
          new TranslationOutputRepetitionGuard();
        repetitionGuards.set(guardKey, guard);

        if (guard.push(chunk.text)) {
          stoppedForRepetition = true;
          repetitionController.abort(
            new Error(translationErrorCodes.repetitiveModelOutput)
          );
        }
      },
    });

    try {
      const finishReason = await result.finishReason;
      if (!isCompletedModelFinishReason(finishReason)) {
        throw new Error(translationErrorCodes.incompleteModelOutput);
      }
      return parseTranslationOutput(await result.output);
    } catch (error) {
      if (stoppedForRepetition && !abortSignal?.aborted) {
        throw new Error(translationErrorCodes.repetitiveModelOutput);
      }
      if (
        NoOutputGeneratedError.isInstance(error) &&
        APICallError.isInstance(recordedStreamError)
      ) {
        throw recordedStreamError;
      }
      throw error;
    }
  };

  const initialPrompt =
    `Translate only the \`core\` subtitles. Use \`before\` and \`after\` only as context. ` +
    `Return a JSON object with one \`elements\` array containing exactly ${core.length} translated strings ` +
    `in the same order as \`core\`, with no other properties.\n` +
    `This is a one-to-one mapping: \`elements[0]\` translates \`core[0]\`, \`elements[1]\` translates \`core[1]\`, and so on. ` +
    `Do not add, remove, split, merge, summarize, explain, or renumber subtitles.\n\n` +
    `A bracketed note such as [source phrase repeats N times total] is input metadata, not subtitle text. ` +
    `Interpret repeated source phrases naturally and never output the bracketed note.\n\n` +
    JSON.stringify({
      before: compactedBefore,
      core: compactedCore,
      after: compactedAfter,
    });

  const output = await runTranslationRequest(initialPrompt);
  validateTranslationOutputForCore(output, compactedCore);
  return output;
}

function parseSubtitle(
  fileContent: string,
  fileExtension: string
): ParsedSubtitle {
  if (["srt", "vtt"].includes(fileExtension)) {
    return parseSync(fileContent) as unknown as Array<
      SubtitleCue | SubtitleHeader
    >;
  }
  if (["ass", "ssa"].includes(fileExtension)) {
    const parsedAssSubtitle = assParser(fileContent) as AssSection[];
    const events = parsedAssSubtitle
      .find((section) => section.section === "Events")
      ?.body?.filter(
        (line) =>
          line.key === "Dialogue" &&
          typeof line.value === "object" &&
          line.value !== null &&
          !Array.isArray(line.value) &&
          typeof line.value.Text === "string"
      )
      .map((line) => {
        const value = line.value as Record<string, string>;
        return {
          type: "cue" as const,
          data: {
            text: value.Text,
            start: value.Start ?? "",
            end: value.End ?? "",
          },
        };
      }) ?? [];
    return {
      full: parsedAssSubtitle,
      events,
      ...(fileExtension === "ssa"
        ? { source: { format: "ssa" as const, text: fileContent } }
        : {}),
    };
  }
  throw new Error(translationErrorCodes.unsupportedFileExtension);
}

export function parseSubtitleText(
  fileContent: string,
  fileExtension: SubtitleFileExtension
): ParsedSubtitle {
  return parseSubtitle(fileContent, fileExtension);
}

export function readSubtitleSourceSnapshot(
  filePath: string,
  extension: SubtitleFileExtension,
  metadata: { size: number; mtimeMs: number },
  options: { readFile?: (filePath: string) => Buffer } = {}
): {
  parsed: ParsedSubtitle;
  text: string;
  encoding: string;
  fingerprint: TranslationSourceFingerprint;
} {
  const buffer = (options.readFile ?? fs.readFileSync)(filePath);
  const decoded = decodeSubtitleBuffer(buffer);
  const parsed = parseSubtitleText(decoded.text, extension);
  return {
    parsed,
    text: decoded.text,
    encoding: decoded.encoding,
    fingerprint: createSubtitleSourceFingerprint(
      buffer,
      parsed,
      extension,
      metadata
    ),
  };
}

function parseSubtitleFile(
  filePath: string,
  fileExtension: SubtitleFileExtension
): ParsedSubtitle {
  return parseSubtitle(readSubtitleFile(filePath).text, fileExtension);
}

function createAssSubtitleFromCues(events: SubtitleCue[]): AssSubtitle {
  return {
    events,
    full: createDefaultAssSections(events) as AssSection[],
  };
}

function saveTranslated(
  outputPath: string,
  parsedSubtitle: ParsedSubtitle,
  outputFormat: SubtitleOutputFormat,
  assFonts: AssBilingualFontOptions = {},
  sourceFormat?: SubtitleFileExtension
): void {
  let newSubtitle = "";
  if (
    outputFormat === "srt-translation" ||
    outputFormat === "srt-bilingual" ||
    outputFormat === "srt-original-translation"
  ) {
    const sourceIsAss = !Array.isArray(parsedSubtitle);
    const translatedNodes = getSubtitleCues(parsedSubtitle).map((node) => {
      const originalText = sourceIsAss
        ? assTextToPlainText(node.data.text)
        : node.data.text;
      const translatedText = hasSubtitleTranslationText(
        node.data.translatedText
      )
        ? sourceIsAss
          ? assTextToPlainText(node.data.translatedText)
          : node.data.translatedText
        : undefined;
      return {
        type: node.type,
        data: {
          start: subtitleTimestampToMilliseconds(node.data.start),
          end: subtitleTimestampToMilliseconds(node.data.end),
          text: formatSrtOutputText({
            originalText,
            translatedText,
            outputFormat,
          }),
        },
      };
    });
    newSubtitle = stringifySync(translatedNodes as NodeList, { format: "SRT" });
  } else if (
    sourceFormat === "ssa" ||
    (!Array.isArray(parsedSubtitle) && parsedSubtitle.source?.format === "ssa")
  ) {
    if (Array.isArray(parsedSubtitle) || parsedSubtitle.source?.format !== "ssa") {
      throw createSsaToAssConversionError({
        reason: "missing-source",
        location: "SSA source",
      });
    }
    newSubtitle = convertSsaToBilingualAss({
      sourceText: parsedSubtitle.source.text,
      events: parsedSubtitle.events,
      outputFormat,
      fonts: assFonts,
    });
  } else {
    const canPreserveAssStyles =
      !Array.isArray(parsedSubtitle) &&
      parsedSubtitle.full.some(
        (section) =>
          section.section === "V4+ Styles" &&
          section.body?.some((line) => line.key === "Style")
      );
    const assSubtitle = canPreserveAssStyles
      ? (parsedSubtitle as AssSubtitle)
      : createAssSubtitleFromCues(getSubtitleCues(parsedSubtitle));
    const { full, stylesBySource } = addAssBilingualStyles(
      assSubtitle.full,
      assFonts
    );
    const events = assSubtitle.events;
    // Use sequential alignment with Events order instead of text matching to avoid misalignment
    let dialogueIndex = 0;
    newSubtitle = assStringify(
      full.map((section) => {
        if (section.section === "Events" && section.body) {
          return {
            ...section,
            body: section.body.map((line) => {
              if (line.key === "Dialogue") {
                const currentEvent = events[dialogueIndex++];
                const translatedText =
                  currentEvent &&
                  hasSubtitleTranslationText(
                    currentEvent.data.translatedText
                  )
                    ? currentEvent.data.translatedText
                    : undefined;
                const value =
                  typeof line.value === "object" &&
                  line.value !== null &&
                  !Array.isArray(line.value)
                    ? line.value
                    : {};
                const styleNames =
                  stylesBySource.get(value.Style ?? "Default") ??
                  stylesBySource.get("Default") ??
                  stylesBySource.values().next().value;
                return {
                  key: "Dialogue",
                  value: {
                    ...value,
                    Text: styleNames
                      ? formatAssBilingualStyledText({
                          originalText: value.Text ?? "",
                          translatedText,
                          order:
                            outputFormat === "ass-original-translation"
                              ? "original+translate"
                              : "translate+original",
                          translationStyle: styleNames.translation,
                          originalStyle: styleNames.original,
                        })
                      : translatedText ?? (value.Text ?? ""),
                  },
                };
              }
              return line;
            }),
          };
        }
        return section;
      })
    );
  }

  // Atomic write to avoid renderer reading partial file during concurrent updates
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, newSubtitle, "utf8");
  try {
    fs.renameSync(tmpPath, outputPath);
  } catch {
    // Fallback for filesystems where rename might not be atomic
    fs.writeFileSync(outputPath, newSubtitle, "utf8");
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
}

function validateSubtitleOutputCompatibility(
  parsedSubtitle: ParsedSubtitle,
  sourceFormat: SubtitleFileExtension,
  outputFormat: SubtitleOutputFormat,
  assFonts: AssBilingualFontOptions = {}
): void {
  if (
    sourceFormat !== "ssa" ||
    (outputFormat !== "ass-bilingual" &&
      outputFormat !== "ass-original-translation")
  ) {
    return;
  }
  if (Array.isArray(parsedSubtitle) || parsedSubtitle.source?.format !== "ssa") {
    throw createSsaToAssConversionError({
      reason: "missing-source",
      location: "SSA source",
    });
  }
  convertSsaToBilingualAss({
    sourceText: parsedSubtitle.source.text,
    events: parsedSubtitle.events,
    outputFormat,
    fonts: assFonts,
  });
}

async function analyzeSubtitlesForContext(
  subtitles: string[],
  {
    apiKeys,
    apiHost,
    model,
    lang,
    temperature = 0.3,
    requestRateLimiter,
    abortSignal,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
    requestRateLimiter?: RequestRateLimiter;
    abortSignal?: AbortSignal;
  }
): Promise<string> {
  const sampledSubtitles = sampleSubtitlesForAnalysis(subtitles);
  if (sampledSubtitles.length === 0) return "";

  const ai = getAi({ apiKey: getFirstValidApiKey(apiKeys), apiHost });

  await requestRateLimiter?.waitForSlot(abortSignal);
  const result = await generateText({
    model: ai(model),
    temperature,
    output: Output.json(),
    system: `# System Prompt

You are a subtitle content analyst assisting a translation and glossary extraction system.

## Task
Analyze subtitle samples and return one JSON object with exactly these properties:
- plotSummary: a string with the plot summary
- glossary: an array of glossary entry objects

## plotSummary
   - Language: ${lang}
   - Length: 5–10 sentences
   - Must be clear, coherent, and written in natural ${lang}
   - Avoid literal stitching of subtitles

## glossary
   - Up to 20 items
   - Include rare words, character names, places, organizations, fictional elements, or jargon
   - Every entry must include term, description, category, preferredTranslation, and notes
   - category must be person, place, organization, jargon, fictional, other, or null
   - Use null for category, preferredTranslation, or notes when not applicable
   - Do not invent glossary entries merely to make the array non-empty.`,
    prompt:
      `Produce a plot summary in ${lang} and a glossary from this sample:\n` +
      sampledSubtitles.join("\n"),
    maxRetries: 0,
    abortSignal,
  });

  if (!isCompletedModelFinishReason(result.finishReason)) {
    throw new Error(translationErrorCodes.incompleteModelOutput);
  }

  const parsedAnalysis = subtitleAnalysisSchema.safeParse(result.output);
  if (!parsedAnalysis.success) {
    throw new Error(
      `${translationErrorCodes.incompleteModelOutput}: invalid content analysis output`
    );
  }
  return formatSubtitleAnalysis(parsedAnalysis.data);
}

async function detectSubtitleLanguage(
  subtitles: string[],
  {
    apiKeys,
    apiHost,
    model,
    requestRateLimiter,
    abortSignal,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    requestRateLimiter?: RequestRateLimiter;
    abortSignal?: AbortSignal;
  }
): Promise<string> {
  const sampledSubtitles = sampleSubtitlesForAnalysis(subtitles);
  if (sampledSubtitles.length === 0) return "";

  const ai = getAi({ apiKey: getFirstValidApiKey(apiKeys), apiHost });
  await requestRateLimiter?.waitForSlot(abortSignal);
  const result = await generateText({
    model: ai(model),
    temperature: 0,
    output: Output.json(),
    system: `Detect the primary spoken language of subtitle samples.
Return one JSON object with exactly one property named "language".
The value must be the language's common English name. Do not infer the language from filenames and do not explain the answer.`,
    prompt: sampledSubtitles.join("\n"),
    maxRetries: 0,
    abortSignal,
  });

  if (!isCompletedModelFinishReason(result.finishReason)) {
    throw new Error(translationErrorCodes.incompleteModelOutput);
  }

  const parsed = z
    .object({ language: z.string().trim().min(1) })
    .safeParse(result.output);
  if (!parsed.success) {
    throw new Error(
      `${translationErrorCodes.incompleteModelOutput}: invalid language detection output`
    );
  }
  return parsed.data.language;
}

export {
  translateSubtitleChunk,
  parseSubtitle,
  parseSubtitleFile,
  saveTranslated,
  analyzeSubtitlesForContext,
  detectSubtitleLanguage,
  validateSubtitleOutputCompatibility,
};
