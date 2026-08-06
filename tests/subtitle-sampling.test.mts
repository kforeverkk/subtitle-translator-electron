import assert from "node:assert/strict";
import test from "node:test";
import {
  getSubtitleAnalysisPlan,
  sampleSubtitlesForAnalysis,
  shouldAnalyzeSubtitles,
} from "../electron/main/utils/subtitle-sampling.ts";

test("analyzes only when a sufficiently large subtitle has no cached analysis", () => {
  assert.equal(shouldAnalyzeSubtitles(undefined, 40, 40), true);
  assert.equal(shouldAnalyzeSubtitles("Existing context", 40, 40), false);
  assert.equal(shouldAnalyzeSubtitles(undefined, 39, 40), false);
});

test("requires analysis from 20 cues and restarts unsafe legacy progress", () => {
  assert.deepEqual(getSubtitleAnalysisPlan(undefined, 19, 0, 20), {
    requiresAnalysis: false,
    shouldAnalyze: false,
    shouldRestartForMissingAnalysis: false,
  });
  assert.deepEqual(getSubtitleAnalysisPlan(undefined, 20, 0, 20), {
    requiresAnalysis: true,
    shouldAnalyze: true,
    shouldRestartForMissingAnalysis: false,
  });
  assert.deepEqual(getSubtitleAnalysisPlan(undefined, 20, 5, 20), {
    requiresAnalysis: true,
    shouldAnalyze: true,
    shouldRestartForMissingAnalysis: true,
  });
  assert.deepEqual(
    getSubtitleAnalysisPlan("Existing context", 20, 5, 20),
    {
      requiresAnalysis: true,
      shouldAnalyze: false,
      shouldRestartForMissingAnalysis: false,
    }
  );
  assert.deepEqual(getSubtitleAnalysisPlan(undefined, 19, 5, 20), {
    requiresAnalysis: false,
    shouldAnalyze: false,
    shouldRestartForMissingAnalysis: false,
  });
});

test("samples deterministically across the full timeline", () => {
  const subtitles = Array.from({ length: 100 }, (_, index) => `Cue ${index}`);
  const first = sampleSubtitlesForAnalysis(subtitles, {
    maxCharacters: 10_000,
    maxLines: 5,
  });
  const second = sampleSubtitlesForAnalysis(subtitles, {
    maxCharacters: 10_000,
    maxLines: 5,
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first, ["Cue 0", "Cue 25", "Cue 50", "Cue 74", "Cue 99"]);
});

test("respects line and character budgets after whitespace normalization", () => {
  const sample = sampleSubtitlesForAnalysis(
    ["  First\nline  ", "Second line", "Third line", "Fourth line"],
    { maxCharacters: 24, maxLines: 3 }
  );

  assert.ok(sample.length <= 3);
  assert.ok(sample.join("\n").length <= 24);
  assert.ok(sample.every((line) => !line.includes("\n")));
});

test("returns no sample for an empty budget", () => {
  assert.deepEqual(
    sampleSubtitlesForAnalysis(["A subtitle"], { maxCharacters: 0 }),
    []
  );
});
