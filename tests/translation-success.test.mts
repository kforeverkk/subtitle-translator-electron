import assert from "node:assert/strict";
import test from "node:test";
import {
  reachedTranslationSuccessPrompt,
  TRANSLATION_SUCCESS_PROMPT_INTERVAL,
} from "../src/utils/translation-success.ts";

test("prompts once whenever the success count crosses a 20-file boundary", () => {
  assert.equal(TRANSLATION_SUCCESS_PROMPT_INTERVAL, 20);
  assert.equal(reachedTranslationSuccessPrompt(19, 20), true);
  assert.equal(reachedTranslationSuccessPrompt(20, 21), false);
  assert.equal(reachedTranslationSuccessPrompt(39, 40), true);
});

test("does not prompt when the count is unchanged, reduced, or invalid", () => {
  assert.equal(reachedTranslationSuccessPrompt(20, 20), false);
  assert.equal(reachedTranslationSuccessPrompt(20, 1), false);
  assert.equal(reachedTranslationSuccessPrompt(Number.NaN, 20), false);
});
