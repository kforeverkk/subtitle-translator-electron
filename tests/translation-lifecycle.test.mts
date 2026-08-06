import assert from "node:assert/strict";
import test from "node:test";
import {
  TranslationControllerRegistry,
  sendWebContentsMessageSafely,
} from "../electron/main/utils/translation-lifecycle.ts";

test("cancels every controller for one translation task", () => {
  const registry = new TranslationControllerRegistry();
  const firstController = new AbortController();
  const secondController = new AbortController();

  registry.register("task-a", firstController);
  registry.register("task-a", secondController);
  registry.cancel("task-a");

  assert.equal(firstController.signal.aborted, true);
  assert.equal(secondController.signal.aborted, true);
  assert.equal(registry.has("task-a"), true);
});

test("cancels all active tasks without releasing them before cleanup", () => {
  const registry = new TranslationControllerRegistry();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const unregisterFirst = registry.register("task-a", firstController);
  const unregisterSecond = registry.register("task-b", secondController);

  registry.cancelAll();

  assert.equal(firstController.signal.aborted, true);
  assert.equal(secondController.signal.aborted, true);
  assert.equal(registry.has("task-a"), true);
  assert.equal(registry.has("task-b"), true);

  unregisterFirst();
  unregisterSecond();
  assert.equal(registry.has("task-a"), false);
  assert.equal(registry.has("task-b"), false);
});

test("does not cancel a controller after it has been unregistered", () => {
  const registry = new TranslationControllerRegistry();
  const controller = new AbortController();
  const unregister = registry.register("task-a", controller);

  unregister();
  registry.cancelAll();

  assert.equal(controller.signal.aborted, false);
  assert.equal(registry.has("task-a"), false);
});

test("sends an IPC message to a live web contents target", () => {
  const received: Array<{ channel: string; payload: unknown }> = [];
  const sent = sendWebContentsMessageSafely(
    {
      isDestroyed: () => false,
      send: (channel, payload) => {
        received.push({ channel, payload });
      },
    },
    "batch-progress",
    { taskId: "task-a", status: "translating" }
  );

  assert.equal(sent, true);
  assert.deepEqual(received, [
    {
      channel: "batch-progress",
      payload: { taskId: "task-a", status: "translating" },
    },
  ]);
});

test("skips destroyed IPC targets and contains close-race send errors", () => {
  let destroyedSendCount = 0;
  const destroyedResult = sendWebContentsMessageSafely(
    {
      isDestroyed: () => true,
      send: () => {
        destroyedSendCount++;
      },
    },
    "batch-progress",
    {}
  );
  const throwingResult = sendWebContentsMessageSafely(
    {
      isDestroyed: () => false,
      send: () => {
        throw new Error("Render frame was disposed");
      },
    },
    "batch-progress",
    {}
  );

  assert.equal(destroyedResult, false);
  assert.equal(destroyedSendCount, 0);
  assert.equal(throwingResult, false);
});
