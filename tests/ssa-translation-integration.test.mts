import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { parseSsaToAssConversionError } from "../electron/shared/ssa-to-ass-error.ts";
import {
  createTranslationCacheDocument,
  parseSubtitle,
  parseTranslationCache,
  saveTranslated,
  validateSubtitleOutputCompatibility,
  type AssSubtitle,
} from "../electron/main/utils/translate.ts";

const source = readFileSync(
  new URL("./fixtures/ssa/styled-effects.ssa", import.meta.url),
  "utf8"
);

test("retains original SSA source in new parsed subtitles and v3 checkpoints", () => {
  const subtitle = parseSubtitle(source, "ssa") as AssSubtitle;
  assert.deepEqual(subtitle.source, { format: "ssa", text: source });

  const document = createTranslationCacheDocument({
    subtitle,
    sourceName: "styled-effects.ssa",
    format: "ssa",
    configFingerprint: "a".repeat(64),
    taskId: "11111111-1111-4111-8111-111111111111",
  });
  const reparsed = parseTranslationCache(JSON.stringify(document));
  assert.deepEqual((reparsed.subtitle as AssSubtitle).source, {
    format: "ssa",
    text: source,
  });
});

test("keeps legacy SSA checkpoints readable but rejects lossy ASS output", () => {
  const parsed = parseSubtitle(source, "ssa") as AssSubtitle;
  const legacySubtitle: AssSubtitle = {
    full: parsed.full,
    events: parsed.events,
  };
  const legacyDocument = {
    version: 1,
    format: "ssa",
    source: { name: "legacy.ssa" },
    subtitle: legacySubtitle,
  };
  assert.doesNotThrow(() =>
    parseTranslationCache(JSON.stringify(legacyDocument))
  );

  assert.throws(
    () =>
      validateSubtitleOutputCompatibility(
        legacySubtitle,
        "ssa",
        "ass-bilingual",
        {}
      ),
    (error: unknown) => {
      assert.deepEqual(
        parseSsaToAssConversionError(
          error instanceof Error ? error.message : ""
        ),
        { reason: "missing-source", location: "SSA source" }
      );
      return true;
    }
  );
});

test("writes SSA input through the lossless ASS conversion path", () => {
  const parsed = parseSubtitle(source, "ssa") as AssSubtitle;
  parsed.events[0].data.translatedText = "译文";
  const outputPath = path.join(tmpdir(), `ssa-output-${randomUUID()}.ass`);
  try {
    validateSubtitleOutputCompatibility(
      parsed,
      "ssa",
      "ass-bilingual",
      {}
    );
    saveTranslated(outputPath, parsed, "ass-bilingual", {}, "ssa");
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /\[V4\+ Styles\]/);
    assert.match(output, /Times New Roman,28,&H20FFFFFF/);
    assert.match(output, /{\\rST Translation 0}译文/);
    assert.match(output, /Banner;20;0;10/);
    assert.doesNotMatch(output, /Style: Default,Arial,20,/);
  } finally {
    rmSync(outputPath, { force: true });
    rmSync(`${outputPath}.tmp`, { force: true });
  }
});
