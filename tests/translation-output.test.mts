import assert from "node:assert/strict";
import test from "node:test";
import { NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import {
  createTranslationOutputValidationError,
  createTranslationRepairPrompt,
  isCompletedModelFinishReason,
  parseTranslationOutput,
  TranslationOutputRepetitionGuard,
  validateTranslationOutputForCore,
  withBareTranslationArrayFallback,
} from "../electron/main/utils/translation-output.ts";

test("accepts only a normally completed model response", () => {
  assert.equal(isCompletedModelFinishReason("stop"), true);
  assert.equal(isCompletedModelFinishReason("length"), false);
  assert.equal(isCompletedModelFinishReason("content-filter"), false);
});

test("accepts wrapped and bare translation arrays from compatible endpoints", () => {
  const translations = ["第一行", "第二行"];

  assert.deepEqual(
    parseTranslationOutput({ elements: translations }),
    translations
  );
  assert.deepEqual(parseTranslationOutput(translations), translations);
});

test("rejects malformed translation output", () => {
  assert.throws(
    () => parseTranslationOutput({ elements: ["第一行", 2] }),
    /expected an array of strings/
  );
  assert.throws(
    () => parseTranslationOutput({ translations: ["第一行"] }),
    /expected an array of strings/
  );
});

test("validates translation count and non-empty subtitles", () => {
  assert.equal(
    createTranslationOutputValidationError(["第一行", "第二行"], ["A", "B"]),
    undefined
  );

  assert.throws(
    () => validateTranslationOutputForCore(["第一行", "第二行", "第三行"], ["A", "B"]),
    /expected 2 non-empty subtitles, got 3/
  );
  assert.throws(
    () => validateTranslationOutputForCore(["第一行", ""], ["A", "B"]),
    /expected 2 non-empty subtitles, got 2/
  );
});

test("builds a repair prompt with validation feedback and previous output", () => {
  const prompt = createTranslationRepairPrompt({
    before: ["Previously"],
    core: ["Hello.", "Goodbye."],
    after: ["Later"],
    invalidOutput: ["哈囉。", "再見。", "多出來的字幕。"],
    validationError:
      "Translation output validation failed: expected 2 non-empty subtitles, got 3",
  });

  assert.match(prompt, /expected 2 non-empty subtitles, got 3/);
  assert.match(prompt, /exactly 2 strings/);
  assert.match(prompt, /previousInvalidOutput/);
  assert.match(prompt, /Do not add, remove, split, merge/);
});

test("preserves array output validation while accepting a bare array", async () => {
  const output = withBareTranslationArrayFallback(
    Output.array({ element: z.string() })
  );
  const context = {} as never;

  assert.deepEqual(
    await output.parseCompleteOutput(
      { text: '{"elements":["第一行","第二行"]}' },
      context
    ),
    ["第一行", "第二行"]
  );
  assert.deepEqual(
    await output.parseCompleteOutput(
      { text: '["第一行","第二行"]' },
      context
    ),
    ["第一行", "第二行"]
  );

  await assert.rejects(
    output.parseCompleteOutput({ text: '["第一行",2]' }, context),
    NoObjectGeneratedError
  );
  await assert.rejects(
    output.parseCompleteOutput({ text: "not json" }, context),
    NoObjectGeneratedError
  );
});

test("detects a pathological exact cycle across streamed chunks", () => {
  const guard = new TranslationOutputRepetitionGuard();
  const repeated = "the model is stuck in a loop. ".repeat(300);

  assert.equal(guard.push(repeated.slice(0, 4_000)), false);
  assert.equal(guard.push(repeated.slice(4_000, 8_000)), false);
  assert.equal(guard.push(repeated.slice(8_000)), true);
});

test("allows short repetition and long non-periodic translation text", () => {
  const shortRepetitionGuard = new TranslationOutputRepetitionGuard();
  assert.equal(
    shortRepetitionGuard.push("No! ".repeat(100)),
    false
  );

  const ordinaryTextGuard = new TranslationOutputRepetitionGuard();
  const ordinaryText = Array.from(
    { length: 1_200 },
    (_, index) => `Subtitle line ${index}: unique translated content. `
  ).join("");
  assert.equal(ordinaryTextGuard.push(ordinaryText), false);
});

test("does not combine independent output channels", () => {
  const textGuard = new TranslationOutputRepetitionGuard();
  const reasoningGuard = new TranslationOutputRepetitionGuard();
  const halfWindow = "repeat ".repeat(600);

  assert.equal(textGuard.push(halfWindow), false);
  assert.equal(reasoningGuard.push(halfWindow), false);
});
