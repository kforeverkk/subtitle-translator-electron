import assert from "node:assert/strict";
import test from "node:test";
import {
  markBatchInvocationFailed,
  type FileProgress,
} from "../src/utils/batch-progress.ts";

test("marks every unfinished file as failed when a batch IPC call is rejected", () => {
  const pendingTaskId = "11111111-1111-4111-8111-111111111111";
  const activeTaskId = "22222222-2222-4222-8222-222222222222";
  const missingTaskId = "33333333-3333-4333-8333-333333333333";
  const previous: Record<string, FileProgress> = {
    [pendingTaskId]: {
      progress: 0,
      status: "pending",
      model: "saved-model",
      targetLanguage: "French",
    },
    [activeTaskId]: {
      progress: 45,
      status: "translating",
      outputPath: "active.fr.srt",
    },
  };

  const next = markBatchInvocationFailed(
    previous,
    [
      { taskId: pendingTaskId, path: "pending.srt", name: "pending.srt" },
      { taskId: activeTaskId, path: "active.srt", name: "active.srt" },
      { taskId: missingTaskId, path: "missing.srt", name: "missing.srt" },
    ],
    {
      error: "Invalid batch request",
      model: "fallback-model",
      targetLanguage: "English",
    }
  );

  assert.deepEqual(next[pendingTaskId], {
    progress: 0,
    status: "error",
    error: "Invalid batch request",
    model: "saved-model",
    targetLanguage: "French",
  });
  assert.deepEqual(next[activeTaskId], {
    progress: 0,
    status: "error",
    error: "Invalid batch request",
    outputPath: "active.fr.srt",
    model: "fallback-model",
    targetLanguage: "English",
  });
  assert.deepEqual(next[missingTaskId], {
    progress: 0,
    status: "error",
    error: "Invalid batch request",
    model: "fallback-model",
    targetLanguage: "English",
  });
  assert.equal(previous[activeTaskId].status, "translating");
});

test("preserves completed and already failed files", () => {
  const doneTaskId = "44444444-4444-4444-8444-444444444444";
  const failedTaskId = "55555555-5555-4555-8555-555555555555";
  const unrelatedTaskId = "66666666-6666-4666-8666-666666666666";
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
    [doneTaskId]: done,
    [failedTaskId]: failed,
    [unrelatedTaskId]: unrelated,
  };

  const next = markBatchInvocationFailed(
    previous,
    [
      { taskId: doneTaskId, path: "done.srt", name: "done.srt" },
      { taskId: failedTaskId, path: "failed.srt", name: "failed.srt" },
    ],
    {
      error: "Batch failure",
      model: "model",
      targetLanguage: "English",
    }
  );

  assert.strictEqual(next[doneTaskId], done);
  assert.strictEqual(next[failedTaskId], failed);
  assert.strictEqual(next[unrelatedTaskId], unrelated);
});

test("keeps two tasks for the same source path independent", () => {
  const englishTaskId = "77777777-7777-4777-8777-777777777777";
  const frenchTaskId = "88888888-8888-4888-8888-888888888888";
  const sourcePath = "movie.srt";
  const previous: Record<string, FileProgress> = {
    [englishTaskId]: {
      progress: 100,
      status: "done",
      targetLanguage: "English",
    },
    [frenchTaskId]: {
      progress: 40,
      status: "translating",
      targetLanguage: "French",
    },
  };

  const next = markBatchInvocationFailed(
    previous,
    [{ taskId: frenchTaskId, path: sourcePath, name: sourcePath }],
    {
      error: "French request failed",
      model: "model",
      targetLanguage: "French",
    }
  );

  assert.strictEqual(next[englishTaskId], previous[englishTaskId]);
  assert.equal(next[frenchTaskId].status, "error");
  assert.equal(next[frenchTaskId].error, "French request failed");
});
