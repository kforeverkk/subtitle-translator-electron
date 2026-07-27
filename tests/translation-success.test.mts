import assert from "node:assert/strict";
import test from "node:test";
import { reachedTranslationSuccessPrompt } from "../src/utils/translation-success.ts";

test("shows the coffee prompt when a new 20-translation milestone is reached", () => {
  assert.equal(reachedTranslationSuccessPrompt(19, 20), true);
  assert.equal(reachedTranslationSuccessPrompt(39, 40), true);
  assert.equal(reachedTranslationSuccessPrompt(59, 60), true);
});

test("does not show the coffee prompt between milestones or on restart", () => {
  assert.equal(reachedTranslationSuccessPrompt(20, 20), false);
  assert.equal(reachedTranslationSuccessPrompt(20, 21), false);
  assert.equal(reachedTranslationSuccessPrompt(38, 39), false);
});
