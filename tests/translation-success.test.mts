import assert from "node:assert/strict";
import test from "node:test";
import {
  getTranslationSuccessPromptCount,
  normalizeTranslationSuccessCount,
  reachedTranslationSuccessPrompt,
  TRANSLATION_SUCCESS_PROMPT_INTERVAL,
} from "../src/utils/translation-success.ts";

test("prompts once whenever the success count crosses a 20-file boundary", () => {
  assert.equal(TRANSLATION_SUCCESS_PROMPT_INTERVAL, 20);
  for (let currentCount = 1; currentCount <= 1_000; currentCount += 1) {
    assert.equal(
      reachedTranslationSuccessPrompt(currentCount - 1, currentCount),
      currentCount % 20 === 0,
      `unexpected prompt decision at success ${currentCount}`
    );
  }
});

test("does not prompt when the count is unchanged, reduced, or invalid", () => {
  assert.equal(reachedTranslationSuccessPrompt(20, 20), false);
  assert.equal(reachedTranslationSuccessPrompt(20, 1), false);
  assert.equal(reachedTranslationSuccessPrompt(Number.NaN, 20), false);
  assert.equal(reachedTranslationSuccessPrompt(-1, 1), false);
  assert.equal(reachedTranslationSuccessPrompt("19", 20), false);
});

test("queues every crossed 20-file boundary without replaying on startup", () => {
  assert.equal(getTranslationSuccessPromptCount(19, 20), 1);
  assert.equal(getTranslationSuccessPromptCount(19, 40), 2);
  assert.equal(getTranslationSuccessPromptCount(20, 40), 1);
  assert.equal(getTranslationSuccessPromptCount(40, 40), 0);
});

test("normalizes corrupt persisted success counts before incrementing", () => {
  assert.equal(normalizeTranslationSuccessCount(19.9), 19);
  assert.equal(normalizeTranslationSuccessCount(-20), 0);
  assert.equal(normalizeTranslationSuccessCount(Number.NaN), 0);
  assert.equal(normalizeTranslationSuccessCount("20"), 0);
});
