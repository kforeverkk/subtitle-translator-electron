import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssSubtitle,
  ParsedSubtitle,
} from "../electron/main/utils/translate.ts";
import {
  SUBTITLE_CONTENT_HASH_VERSION,
  createSubtitleContentHash,
  createSubtitleSourceFingerprint,
  hasMatchingCheckpointSource,
} from "../electron/main/utils/subtitle-source-identity.ts";

const srt = (overrides: Record<string, unknown> = {}): ParsedSubtitle => [
  {
    type: "cue",
    data: {
      start: 1_000,
      end: 2_000,
      text: "Hello\nworld",
      ...overrides,
    },
  },
];

const ass = ({
  fontName = "Arial",
  comment = "first note",
  translatedText,
}: {
  fontName?: string;
  comment?: string;
  translatedText?: string;
} = {}): AssSubtitle => ({
  full: [
    {
      section: "V4+ Styles",
      body: [
        {
          key: "Style",
          value: { Name: "Default", Fontname: fontName, Fontsize: "20" },
        },
      ],
    },
    {
      section: "Events",
      body: [
        { key: "Comment", value: { Text: comment } },
        {
          key: "Dialogue",
          value: {
            Layer: "0",
            Start: "0:00:01.00",
            End: "0:00:02.00",
            Style: "Default",
            Text: "{\\i1}Hello",
          },
        },
      ],
    },
  ],
  events: [
    {
      type: "cue",
      data: {
        start: "0:00:01.00",
        end: "0:00:02.00",
        text: "{\\i1}Hello",
        ...(translatedText === undefined ? {} : { translatedText }),
      },
    },
  ],
});

test("ignores translated text but detects source text, timing, and order changes", () => {
  const original = srt();
  const translated = srt({ translatedText: "你好，世界" });
  assert.equal(
    createSubtitleContentHash(original, "srt"),
    createSubtitleContentHash(translated, "srt")
  );
  assert.notEqual(
    createSubtitleContentHash(original, "srt"),
    createSubtitleContentHash(srt({ text: "Goodbye world" }), "srt")
  );
  assert.notEqual(
    createSubtitleContentHash(original, "srt"),
    createSubtitleContentHash(srt({ start: 1_001 }), "srt")
  );
  assert.notEqual(
    createSubtitleContentHash(
      [...(srt({ text: "First" }) as unknown[]), ...(srt({ text: "Second" }) as unknown[])] as ParsedSubtitle,
      "srt"
    ),
    createSubtitleContentHash(
      [...(srt({ text: "Second" }) as unknown[]), ...(srt({ text: "First" }) as unknown[])] as ParsedSubtitle,
      "srt"
    )
  );
});

test("detects ASS style changes while ignoring translations and pure comments", () => {
  const original = ass();
  assert.equal(
    createSubtitleContentHash(original, "ass"),
    createSubtitleContentHash(ass({ translatedText: "你好" }), "ass")
  );
  assert.equal(
    createSubtitleContentHash(original, "ass"),
    createSubtitleContentHash(ass({ comment: "another note" }), "ass")
  );
  assert.notEqual(
    createSubtitleContentHash(original, "ass"),
    createSubtitleContentHash(ass({ fontName: "Noto Sans" }), "ass")
  );
});

test("keeps raw byte identity separate from normalized subtitle identity", () => {
  const parsed = srt();
  const utf8 = createSubtitleSourceFingerprint(
    Buffer.from("Hello\r\nworld", "utf8"),
    parsed,
    "srt",
    { size: 12, mtimeMs: 100 }
  );
  const utf8Bom = createSubtitleSourceFingerprint(
    Buffer.from("\ufeffHello\nworld", "utf8"),
    parsed,
    "srt",
    { size: 14, mtimeMs: 200 }
  );

  assert.match(utf8.rawHash, /^[a-f\d]{64}$/);
  assert.match(utf8.contentHash, /^[a-f\d]{64}$/);
  assert.equal(utf8.contentHashVersion, SUBTITLE_CONTENT_HASH_VERSION);
  assert.notEqual(utf8.rawHash, utf8Bom.rawHash);
  assert.equal(utf8.contentHash, utf8Bom.contentHash);
});

test("matches modern checkpoints by raw or normalized content, never file metadata alone", () => {
  const parsed = srt();
  const current = createSubtitleSourceFingerprint(
    Buffer.from("current bytes"),
    parsed,
    "srt",
    { size: 13, mtimeMs: 100 }
  );
  const baseCheckpoint = {
    format: "srt" as const,
    source: { name: "movie.srt", fingerprint: current },
    subtitle: parsed,
  };
  const identity = {
    sourceName: "movie.srt",
    format: "srt" as const,
    fingerprint: current,
  };

  assert.equal(hasMatchingCheckpointSource(baseCheckpoint, identity), true);
  assert.equal(
    hasMatchingCheckpointSource(
      {
        ...baseCheckpoint,
        source: {
          ...baseCheckpoint.source,
          fingerprint: { ...current, rawHash: "a".repeat(64) },
        },
      },
      identity
    ),
    true
  );
  assert.equal(
    hasMatchingCheckpointSource(
      {
        ...baseCheckpoint,
        source: {
          ...baseCheckpoint.source,
          fingerprint: {
            ...current,
            rawHash: "a".repeat(64),
            contentHash: "b".repeat(64),
          },
        },
        subtitle: srt({ text: "different content" }),
      },
      identity
    ),
    false
  );
  assert.equal(
    hasMatchingCheckpointSource(baseCheckpoint, {
      ...identity,
      sourceName: "renamed.srt",
    }),
    false
  );
});

test("verifies legacy and unknown-version checkpoints from their subtitle snapshot", () => {
  const parsed = srt();
  const current = createSubtitleSourceFingerprint(
    Buffer.from("current bytes"),
    parsed,
    "srt",
    { size: 13, mtimeMs: 100 }
  );
  const identity = {
    sourceName: "movie.srt",
    format: "srt" as const,
    fingerprint: current,
  };

  assert.equal(
    hasMatchingCheckpointSource(
      {
        format: "srt",
        source: {
          name: "movie.srt",
          fingerprint: { size: 13, mtimeMs: 100 },
        },
        subtitle: srt({ translatedText: "旧译文" }),
      },
      identity
    ),
    true
  );
  assert.equal(
    hasMatchingCheckpointSource(
      {
        format: "srt",
        source: {
          name: "movie.srt",
          fingerprint: {
            ...current,
            contentHashVersion: 99,
            rawHash: "a".repeat(64),
            contentHash: "b".repeat(64),
          },
        },
        subtitle: srt({ translatedText: "旧译文" }),
      },
      identity
    ),
    true
  );
  assert.equal(
    hasMatchingCheckpointSource(
      {
        format: "srt",
        source: { name: "movie.srt" },
        subtitle: srt({ text: "another source" }),
      },
      identity
    ),
    false
  );
});
