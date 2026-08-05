import assert from "node:assert/strict";
import test from "node:test";
import {
  NoObjectGeneratedError,
  NoOutputGeneratedError,
} from "ai";
import { createSsaToAssConversionError } from "../electron/shared/ssa-to-ass-error.ts";
import {
  getErrorDetails,
  isRetryableTranslationError,
  retryTranslation,
} from "../electron/main/utils/translation-retry.ts";

const noWait = async () => {};
const noJitter = () => 0;
const ignoreRetry = () => {};

test("retries two empty model streams and returns the third result", async () => {
  let attempts = 0;

  const result = await retryTranslation(
    async () => {
      attempts++;
      if (attempts < 3) {
        throw new NoOutputGeneratedError({
          message: "No output generated. Check the stream for errors.",
        });
      }
      return "translated";
    },
    undefined,
    { sleep: noWait, random: noJitter, onRetry: ignoreRetry }
  );

  assert.equal(result, "translated");
  assert.equal(attempts, 3);
});

test("throws the third empty-stream error without a fourth attempt", async () => {
  let attempts = 0;
  const errors = Array.from(
    { length: 3 },
    (_, index) =>
      new NoOutputGeneratedError({
        message: `empty stream attempt ${index + 1}`,
      })
  );

  await assert.rejects(
    retryTranslation(
      async () => {
        const error = errors[attempts];
        attempts++;
        throw error;
      },
      undefined,
      { sleep: noWait, random: noJitter, onRetry: ignoreRetry }
    ),
    (error: unknown) => error === errors[2]
  );
  assert.equal(attempts, 3);
});

test("does not retry a deterministic HTTP 401 response", async () => {
  let attempts = 0;
  const unauthorized = Object.assign(new Error("Unauthorized"), {
    status: 401,
  });

  await assert.rejects(
    retryTranslation(
      async () => {
        attempts++;
        throw unauthorized;
      },
      undefined,
      { sleep: noWait, random: noJitter, onRetry: ignoreRetry }
    ),
    (error: unknown) => error === unauthorized
  );
  assert.equal(attempts, 1);
});

test("does not start or continue calls after cancellation", async () => {
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort(new Error("cancelled before start"));
  let callsBeforeStart = 0;

  await assert.rejects(
    retryTranslation(
      async () => {
        callsBeforeStart++;
        return "unexpected";
      },
      undefined,
      {
        abortSignal: alreadyCancelled.signal,
        sleep: noWait,
        random: noJitter,
        onRetry: ignoreRetry,
      }
    ),
    /cancelled before start/
  );
  assert.equal(callsBeforeStart, 0);

  const cancelledDuringWait = new AbortController();
  let callsDuringRetry = 0;
  await assert.rejects(
    retryTranslation(
      async () => {
        callsDuringRetry++;
        throw new NoOutputGeneratedError();
      },
      undefined,
      {
        abortSignal: cancelledDuringWait.signal,
        random: noJitter,
        onRetry: ignoreRetry,
        sleep: async () => {
          cancelledDuringWait.abort(new Error("cancelled during retry"));
          cancelledDuringWait.signal.throwIfAborted();
        },
      }
    ),
    /cancelled during retry/
  );
  assert.equal(callsDuringRetry, 1);
});

test("preserves the existing retryable error categories", () => {
  const noObject = new NoObjectGeneratedError({
    response: {},
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    finishReason: "other",
  });

  assert.equal(
    isRetryableTranslationError(new NoOutputGeneratedError()),
    true
  );
  assert.equal(isRetryableTranslationError(noObject), true);
  assert.equal(
    isRetryableTranslationError(
      Object.assign(new Error("rate limited"), { status: 429 })
    ),
    true
  );
  assert.equal(
    isRetryableTranslationError(
      Object.assign(new Error("service unavailable"), { statusCode: 503 })
    ),
    true
  );
  assert.equal(
    isRetryableTranslationError(new Error("socket hang up")),
    true
  );
  assert.equal(
    isRetryableTranslationError(
      Object.assign(new Error("bad request"), { status: 400 })
    ),
    false
  );
});

test("does not retry an empty-output wrapper around a deterministic HTTP 401", () => {
  const unauthorizedCause = Object.assign(new Error("Invalid API key"), {
    status: 401,
  });
  const wrapped = new NoOutputGeneratedError({
    message: "No output generated. Check the stream for errors.",
    cause: unauthorizedCause,
  });

  assert.equal(isRetryableTranslationError(wrapped), false);
});

test("deduplicates visually identical outer and cause messages", () => {
  const error = new Error(
    "  No output generated.\nCheck the stream for errors.  ",
    {
      cause: new Error(
        "No output generated.   Check the stream for errors."
      ),
    }
  );

  assert.equal(
    getErrorDetails(error).message,
    "No output generated. Check the stream for errors."
  );
});

test("keeps genuinely different outer and cause messages in order", () => {
  const error = new Error("Outer failure", {
    cause: new Error("Provider failure"),
  });

  assert.equal(
    getErrorDetails(error).message,
    "Outer failure | Provider failure"
  );
});

test("keeps structured SSA conversion errors ahead of ordinary causes", () => {
  const structured = createSsaToAssConversionError({
    reason: "invalid-field",
    location: "style Sign.Alignment",
    value: "12",
  });
  const error = new Error(structured.message, {
    cause: new Error("ordinary cause"),
  });

  assert.equal(getErrorDetails(error).message, structured.message);
});
