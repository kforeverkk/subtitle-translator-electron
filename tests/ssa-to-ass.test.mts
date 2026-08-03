import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseSsaToAssConversionError } from "../electron/shared/ssa-to-ass-error.ts";
import { convertSsaToBilingualAss } from "../electron/main/utils/ssa-to-ass.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ssa/${name}`, import.meta.url), "utf8");

test("converts SSA styles, events, effects, and inline tags to standard ASS", () => {
  const output = convertSsaToBilingualAss({
    sourceText: fixture("styled-effects.ssa"),
    events: [
      { data: { translatedText: "你好，世界" } },
      { data: { translatedText: "卡拉 OK" } },
      { data: { translatedText: "图形" } },
    ],
    outputFormat: "ass-bilingual",
    fonts: {},
  });

  assert.match(output, /ScriptType: v4\.00\+/);
  assert.match(output, /\[V4\+ Styles\]/);
  assert.doesNotMatch(output, /\[V4 Styles\]/);
  assert.match(output, /Custom-Metadata: keep:this:value/);
  assert.match(output, /Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding/);

  const alignments = [...output.matchAll(/^Style: (?:Bottom|Top|Middle)[^,]*,(?:[^,]*,){17}(\d+),/gm)].map(
    (match) => Number(match[1])
  );
  assert.deepEqual(alignments, [1, 2, 3, 7, 8, 9, 4, 5, 6]);
  assert.match(output, /Style: BottomLeft,Times New Roman,28,&H20FFFFFF,&H2000FFFF,&H200000FF,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,1,20,21,22,1/);
  assert.match(output, /Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text/);
  assert.match(output, /Dialogue: 0,0:00:01\.00,0:00:03\.00,BottomLeft,Actor,0000,0000,0000,Banner;20;0;10,/);
  assert.match(output, /Banner;20;0;10,{\\rST Translation 0}你好，世界\\N{\\rST Original 0}{\\pos\(100,200\)\\fad\(100,200\)\\i1\\1c&H112233&}Hello, world/);
  assert.match(output, /Scroll up;10;300;20/);
  assert.match(output, /{\\move\(10,20,30,40\)\\k20}Karaoke/);
  assert.match(output, /{\\p1}m 0 0 l 10 0 10 10{\\p0}/);
  assert.match(output, /\[Unknown Section\]\nRawLineWithoutColon\nVendor: leave:all:colons/);
});

test("preserves attachment payload and comments without generic reserialization", () => {
  const source = fixture("attachments.ssa");
  const output = convertSsaToBilingualAss({
    sourceText: source,
    events: [{ data: {} }],
    outputFormat: "ass-original-translation",
    fonts: {},
  });

  const attachmentLines = source
    .slice(source.indexOf("[Fonts]"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  for (const line of attachmentLines) {
    assert.ok(output.includes(line), `missing untouched line: ${line}`);
  }
  assert.doesNotMatch(output, /RAWPAYLOADWITHOUTCOLON: /);
});

test("rejects invalid rendering fields with structured details", () => {
  const source = fixture("attachments.ssa").replace(
    ",2,10,10,10,0,1",
    ",12,10,10,10,0,1"
  );

  assert.throws(
    () =>
      convertSsaToBilingualAss({
        sourceText: source,
        events: [{ data: {} }],
        outputFormat: "ass-bilingual",
        fonts: {},
      }),
    (error: unknown) => {
      const details = parseSsaToAssConversionError(
        error instanceof Error ? error.message : ""
      );
      assert.deepEqual(details, {
        reason: "invalid-field",
        location: "style Default.Alignment",
        value: "12",
      });
      return true;
    }
  );
});
