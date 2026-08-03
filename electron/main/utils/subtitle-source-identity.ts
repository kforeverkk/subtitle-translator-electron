import { createHash } from "node:crypto";
import type {
  ParsedSubtitle,
  SubtitleFileExtension,
} from "./translate";

export const SUBTITLE_CONTENT_HASH_VERSION = 1;

export interface CompleteTranslationSourceFingerprint {
  size: number;
  mtimeMs: number;
  rawHash: string;
  contentHash: string;
  contentHashVersion: number;
}

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPureAssComment(value: unknown): boolean {
  if (!isRecord(value) || typeof value.key !== "string") return false;
  const key = value.key.trim().toLowerCase();
  return key === "comment" || key === ";";
}

function normalizeString(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) {
    return value
      .filter((entry) => !isPureAssComment(entry))
      .map(normalizeValue);
  }
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "translatedText" || value[key] === undefined) continue;
    normalized[key] = normalizeValue(value[key]);
  }
  return normalized;
}

function createNormalizedSubtitle(
  parsed: ParsedSubtitle,
  format: SubtitleFileExtension
): unknown {
  if (Array.isArray(parsed)) return normalizeValue(parsed);

  return normalizeValue({
    full: parsed.full,
    format,
  });
}

export function createSubtitleContentHash(
  parsed: ParsedSubtitle,
  format: SubtitleFileExtension
): string {
  return sha256(
    JSON.stringify({
      version: SUBTITLE_CONTENT_HASH_VERSION,
      format,
      subtitle: createNormalizedSubtitle(parsed, format),
    })
  );
}

export function createSubtitleSourceFingerprint(
  buffer: Uint8Array,
  parsed: ParsedSubtitle,
  format: SubtitleFileExtension,
  metadata: { size: number; mtimeMs: number }
): CompleteTranslationSourceFingerprint {
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    rawHash: sha256(buffer),
    contentHash: createSubtitleContentHash(parsed, format),
    contentHashVersion: SUBTITLE_CONTENT_HASH_VERSION,
  };
}
