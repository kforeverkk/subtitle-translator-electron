import assert from "node:assert/strict";
import test from "node:test";
import {
  markBatchInvocationFailed,
  type FileProgress,
} from "../src/utils/batch-progress.ts";

test("marks every unfinished file as failed when a batch IPC call is rejected", () => {
  const previous: Record<string, FileProgress> = {
    "pending.srt": {
      progress: 0,
      status: "pending",
      model: "saved-model",
      targetLanguage: "French",
    },
    "active.srt": {
      progress: 45,
      status: "translating",
      outputPath: "active.fr.srt",
    },
  };

  const next = markBatchInvocationFailed(
    previous,
    [
      { path: "pending.srt", name: "pending.srt" },
      { path: "active.srt", name: "active.srt" },
      { path: "missing.srt", name: "missing.srt" },
    ],
    {
      error: "Invalid batch request",
      model: "fallback-model",
      targetLanguage: "English",
    }
  );

  assert.deepEqual(next["pending.srt"], {
    progress: 0,
    status: "error",
    error: "Invalid batch request",
    model: "saved-model",
    targetLanguage: "French",
  });
  assert.deepEqual(next["active.srt"], {
    progress: 0,
    status: "error",
    error: "Invalid batch request",
    outputPath: "active.fr.srt",
    model: "fallback-model",
    targetLanguage: "English",
  });
  assert.deepEqual(next["missing.srt"], {
    progress: 0,
    status: "error",
    error: "Invalid batch request",
    model: "fallback-model",
    targetLanguage: "English",
  });
  assert.equal(previous["active.srt"].status, "translating");
});

test("preserves completed and already failed files", () => {
  const done: FileProgress = {
    progress: 100,
    status: "done",
    outputPath: "done.en.srt",
  };
  const failed: FileProgress = {
    progress: 0,
    status: "error",
    error: "File-specific failure",
  };
  const unrelated: FileProgress = {
    progress: 25,
    status: "translating",
  };
  const previous = {
    "done.srt": done,
    "failed.srt": failed,
    "unrelated.srt": unrelated,
  };

  const next = markBatchInvocationFailed(
    previous,
    [
      { path: "done.srt", name: "done.srt" },
      { path: "failed.srt", name: "failed.srt" },
    ],
    {
      error: "Batch failure",
      model: "model",
      targetLanguage: "English",
    }
  );

  assert.strictEqual(next["done.srt"], done);
  assert.strictEqual(next["failed.srt"], failed);
  assert.strictEqual(next["unrelated.srt"], unrelated);
});
