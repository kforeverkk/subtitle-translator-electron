import fs from "node:fs";
import chardet from "chardet";
import iconv from "iconv-lite";
import { translationErrorCodes } from "../../shared/translation-error-codes";

export interface SubtitleEncodingCandidate {
  name: string;
  confidence: number;
}

export interface DecodeSubtitleOptions {
  analyse?: (
    buffer: Uint8Array
  ) => readonly SubtitleEncodingCandidate[];
}

export interface DecodedSubtitleText {
  text: string;
  encoding: string;
}

const minimumConfidence = 80;
const minimumLead = 10;
const replacementCharacter = "\uFFFD";

const canonicalAliases: Record<string, string> = {
  gb18030: "gb18030",
  big5: "big5",
  shiftjis: "shift_jis",
  eucjp: "euc-jp",
  euckr: "euc-kr",
  koi8r: "koi8-r",
  windows874: "windows-874",
  windows1250: "windows-1250",
  windows1251: "windows-1251",
  windows1252: "windows-1252",
  windows1253: "windows-1253",
  windows1254: "windows-1254",
  windows1255: "windows-1255",
  windows1256: "windows-1256",
  windows1257: "windows-1257",
  windows1258: "windows-1258",
};

function createEncodingError(): Error {
  return new Error(translationErrorCodes.subtitleEncoding);
}

function hasPrefix(buffer: Buffer, prefix: readonly number[]): boolean {
  return (
    buffer.length >= prefix.length &&
    prefix.every((byte, index) => buffer[index] === byte)
  );
}

function decodeUtf16(
  bytes: Buffer,
  decoderEncoding: "utf16-le" | "utf16-be",
  reportedEncoding: "utf-16le" | "utf-16be"
): DecodedSubtitleText {
  const text = iconv.decode(bytes, decoderEncoding);
  if (!iconv.encode(text, decoderEncoding).equals(bytes)) {
    throw createEncodingError();
  }
  return { text, encoding: reportedEncoding };
}

function canonicalizeEncoding(name: string): string | undefined {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const alias = canonicalAliases[compact];
  if (alias) return iconv.encodingExists(alias) ? alias : undefined;

  const iso8859 = /^iso8859(\d+)$/.exec(compact);
  if (iso8859) {
    const canonical = `iso-8859-${iso8859[1]}`;
    return iconv.encodingExists(canonical) ? canonical : undefined;
  }
  return undefined;
}

function decodeDetectedLegacyEncoding(
  buffer: Buffer,
  analyse: (
    buffer: Uint8Array
  ) => readonly SubtitleEncodingCandidate[]
): DecodedSubtitleText {
  const candidatesByEncoding = new Map<string, number>();
  for (const candidate of analyse(buffer)) {
    const encoding = canonicalizeEncoding(candidate.name);
    if (!encoding || !Number.isFinite(candidate.confidence)) continue;
    candidatesByEncoding.set(
      encoding,
      Math.max(candidatesByEncoding.get(encoding) ?? -Infinity, candidate.confidence)
    );
  }

  const candidates = [...candidatesByEncoding.entries()].sort(
    (left, right) => right[1] - left[1]
  );
  const [winner, runnerUp] = candidates;
  if (
    !winner ||
    winner[1] < minimumConfidence ||
    (runnerUp && winner[1] - runnerUp[1] < minimumLead)
  ) {
    throw createEncodingError();
  }

  const [encoding] = winner;
  const text = iconv.decode(buffer, encoding);
  if (
    text.includes(replacementCharacter) ||
    !iconv.encode(text, encoding).equals(buffer)
  ) {
    throw createEncodingError();
  }
  return { text, encoding };
}

export function decodeSubtitleBuffer(
  input: Uint8Array,
  options: DecodeSubtitleOptions = {}
): DecodedSubtitleText {
  const buffer = Buffer.from(input);
  if (
    hasPrefix(buffer, [0xff, 0xfe, 0x00, 0x00]) ||
    hasPrefix(buffer, [0x00, 0x00, 0xfe, 0xff])
  ) {
    throw createEncodingError();
  }
  if (hasPrefix(buffer, [0xef, 0xbb, 0xbf])) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(3)
        ),
        encoding: "utf-8",
      };
    } catch {
      throw createEncodingError();
    }
  }
  if (hasPrefix(buffer, [0xff, 0xfe])) {
    return decodeUtf16(buffer.subarray(2), "utf16-le", "utf-16le");
  }
  if (hasPrefix(buffer, [0xfe, 0xff])) {
    return decodeUtf16(buffer.subarray(2), "utf16-be", "utf-16be");
  }
  if (buffer.includes(0)) throw createEncodingError();

  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      encoding: "utf-8",
    };
  } catch {
    const analyse =
      options.analyse ??
      ((value: Uint8Array) => chardet.analyse(value));
    return decodeDetectedLegacyEncoding(buffer, analyse);
  }
}

export function readSubtitleFile(filePath: string): DecodedSubtitleText {
  return decodeSubtitleBuffer(fs.readFileSync(filePath));
}
