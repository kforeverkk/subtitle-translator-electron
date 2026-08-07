import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SETTINGS_QUARANTINE_KEY,
  SETTINGS_SNAPSHOT_KEY,
  startSettingsProtection,
  normalizeProtectedSetting,
  recoverProtectedSettings,
  writeProtectedSettingsSnapshot,
  type SettingsStorage,
} from "../src/utils/settings-storage.ts";

class MemoryStorage implements SettingsStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

const fixedNow = () => "2026-08-07T00:00:00.000Z";

test("normalizes standard, plain, and double-serialized settings", () => {
  assert.equal(normalizeProtectedSetting("language", '"zh-CN"'), '"zh-CN"');
  assert.equal(normalizeProtectedSetting("language", "zh-TW"), '"zh-TW"');
  assert.equal(
    normalizeProtectedSetting("language", '"\\"zh-CN\\""'),
    '"zh-CN"'
  );
  assert.equal(
    normalizeProtectedSetting("translate_context_size", '"20"'),
    "20"
  );
  assert.equal(
    normalizeProtectedSetting("requests_per_minute", "100001"),
    "100000"
  );
});

test("rejects unsupported enum and structural values", () => {
  assert.equal(normalizeProtectedSetting("language", '"fr-FR"'), undefined);
  assert.equal(
    normalizeProtectedSetting("api_keys", '{"key":"secret"}'),
    undefined
  );
  assert.equal(
    normalizeProtectedSetting("subtitle_output_format", '"vtt"'),
    undefined
  );
  assert.equal(
    normalizeProtectedSetting("translation_concurrency", "3"),
    undefined
  );
});

test("keeps a valid live value instead of restoring an older snapshot", () => {
  const storage = new MemoryStorage();
  storage.setItem("language", '"zh-CN"');
  storage.setItem(
    SETTINGS_SNAPSHOT_KEY,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
      values: { language: '"en-US"' },
    })
  );

  const result = recoverProtectedSettings(storage, fixedNow);

  assert.equal(storage.getItem("language"), '"zh-CN"');
  assert.deepEqual(result.recoveredKeys, []);
  const snapshot = JSON.parse(storage.getItem(SETTINGS_SNAPSHOT_KEY)!);
  assert.equal(snapshot.values.language, '"zh-CN"');
});

test("restores only missing and malformed settings from the snapshot", () => {
  const storage = new MemoryStorage();
  storage.setItem("language", "broken-locale");
  storage.setItem("model", '"current-model"');
  storage.setItem(
    SETTINGS_SNAPSHOT_KEY,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
      values: {
        language: '"zh-TW"',
        translate_context_size: "20",
        model: '"old-model"',
      },
    })
  );

  const result = recoverProtectedSettings(storage, fixedNow);

  assert.equal(storage.getItem("language"), '"zh-TW"');
  assert.equal(storage.getItem("translate_context_size"), "20");
  assert.equal(storage.getItem("model"), '"current-model"');
  assert.deepEqual(result.recoveredKeys.sort(), [
    "language",
    "translate_context_size",
  ]);
});

test("quarantines one unrecoverable setting without changing valid siblings", () => {
  const storage = new MemoryStorage();
  storage.setItem("language", '"invalid-locale"');
  storage.setItem("requests_per_minute", "120");

  const result = recoverProtectedSettings(storage, fixedNow);

  assert.equal(storage.getItem("language"), null);
  assert.equal(storage.getItem("requests_per_minute"), "120");
  assert.deepEqual(result.quarantinedKeys, ["language"]);
  const quarantine = JSON.parse(storage.getItem(SETTINGS_QUARANTINE_KEY)!);
  assert.equal(quarantine.values.language, '"invalid-locale"');
});

test("ignores an unknown snapshot version without deleting live values", () => {
  const storage = new MemoryStorage();
  storage.setItem("language", '"zh-CN"');
  storage.setItem(
    SETTINGS_SNAPSHOT_KEY,
    JSON.stringify({ version: 99, values: { language: '"en-US"' } })
  );

  recoverProtectedSettings(storage, fixedNow);

  assert.equal(storage.getItem("language"), '"zh-CN"');
  const snapshot = JSON.parse(storage.getItem(SETTINGS_SNAPSHOT_KEY)!);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.values.language, '"zh-CN"');
});

test("includes API keys in the snapshot without returning their contents", () => {
  const storage = new MemoryStorage();
  storage.setItem("api_keys", JSON.stringify(["virtual-secret"]));

  writeProtectedSettingsSnapshot(storage, fixedNow);

  const snapshot = JSON.parse(storage.getItem(SETTINGS_SNAPSHOT_KEY)!);
  assert.equal(snapshot.values.api_keys, '["virtual-secret"]');
  const result = recoverProtectedSettings(storage, fixedNow);
  assert.deepEqual(result, {
    recoveredKeys: [],
    normalizedKeys: [],
    quarantinedKeys: [],
  });
  assert.equal(JSON.stringify(result).includes("virtual-secret"), false);
});

test("refreshes the snapshot from all current valid values", () => {
  const storage = new MemoryStorage();
  storage.setItem("language", '"zh-CN"');
  storage.setItem("translate_context_size", "30");
  storage.setItem("requests_per_minute", "90");

  writeProtectedSettingsSnapshot(storage, fixedNow);

  const snapshot = JSON.parse(storage.getItem(SETTINGS_SNAPSHOT_KEY)!);
  assert.deepEqual(snapshot.values, {
    language: '"zh-CN"',
    requests_per_minute: "90",
    translate_context_size: "30",
  });
});

test("keeps the last valid snapshot when a live setting disappears or breaks", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    SETTINGS_SNAPSHOT_KEY,
    JSON.stringify({
      version: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
      values: {
        language: '"zh-CN"',
        translate_context_size: "25",
      },
    })
  );
  storage.setItem("translate_context_size", "{broken");

  writeProtectedSettingsSnapshot(storage, fixedNow);

  const snapshot = JSON.parse(storage.getItem(SETTINGS_SNAPSHOT_KEY)!);
  assert.equal(snapshot.values.language, '"zh-CN"');
  assert.equal(snapshot.values.translate_context_size, "25");
});

test("contains one storage failure without exposing another setting", () => {
  const storage = new MemoryStorage();
  storage.setItem("api_keys", JSON.stringify(["virtual-secret"]));
  const originalGetItem = storage.getItem.bind(storage);
  storage.getItem = (key) => {
    if (key === "language") throw new Error("read failure");
    return originalGetItem(key);
  };

  assert.doesNotThrow(() => recoverProtectedSettings(storage, fixedNow));
  assert.equal(storage.getItem("api_keys"), '["virtual-secret"]');
});

test("updates the snapshot after a local-storage event", async () => {
  const storage = new MemoryStorage();
  const target = new EventTarget();
  const controller = startSettingsProtection(storage, target, fixedNow);
  storage.setItem("language", '"zh-CN"');

  target.dispatchEvent(new Event("local-storage"));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  const snapshot = JSON.parse(storage.getItem(SETTINGS_SNAPSHOT_KEY)!);
  assert.equal(snapshot.values.language, '"zh-CN"');
  controller.dispose();
});

test("coalesces repeated setting events into one snapshot flush", async () => {
  class CountingStorage extends MemoryStorage {
    snapshotWrites = 0;

    override setItem(key: string, value: string): void {
      if (key === SETTINGS_SNAPSHOT_KEY) this.snapshotWrites++;
      super.setItem(key, value);
    }
  }

  const storage = new CountingStorage();
  const target = new EventTarget();
  const controller = startSettingsProtection(storage, target, fixedNow);
  storage.snapshotWrites = 0;
  storage.setItem("language", '"zh-CN"');

  target.dispatchEvent(new Event("local-storage"));
  target.dispatchEvent(new Event("local-storage"));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.equal(storage.snapshotWrites, 1);
  controller.dispose();
});

test("reset disables listeners and clears live, snapshot, and quarantine values", async () => {
  const storage = new MemoryStorage();
  const target = new EventTarget();
  storage.setItem("language", '"zh-CN"');
  const controller = startSettingsProtection(storage, target, fixedNow);

  controller.reset();
  target.dispatchEvent(new Event("pagehide"));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.equal(storage.values.size, 0);
});

test("an empty startup does not create a meaningless snapshot", () => {
  const storage = new MemoryStorage();
  const target = new EventTarget();
  const controller = startSettingsProtection(storage, target, fixedNow);

  assert.equal(storage.getItem(SETTINGS_SNAPSHOT_KEY), null);
  controller.dispose();
});

test("pagehide keeps the in-memory snapshot if snapshot storage becomes unavailable", () => {
  const storage = new MemoryStorage();
  const target = new EventTarget();
  storage.setItem("translate_context_size", "33");
  const controller = startSettingsProtection(storage, target, fixedNow);
  storage.removeItem("translate_context_size");

  const originalGetItem = storage.getItem.bind(storage);
  storage.getItem = (key) => {
    if (key === SETTINGS_SNAPSHOT_KEY) {
      throw new Error("snapshot unavailable during pagehide");
    }
    return originalGetItem(key);
  };
  target.dispatchEvent(new Event("pagehide"));
  storage.getItem = originalGetItem;

  const snapshot = JSON.parse(storage.getItem(SETTINGS_SNAPSHOT_KEY)!);
  assert.equal(snapshot.values.translate_context_size, "33");
  controller.dispose();
});

test("starts settings recovery before the renderer reads its initial locale", () => {
  const source = readFileSync(
    new URL("../src/main.tsx", import.meta.url),
    "utf8"
  );
  const initialization = source.indexOf(
    "initializeSettingsProtection(localStorage, window)"
  );
  const localeRead = source.indexOf('localStorage.getItem("language")');

  assert.ok(initialization >= 0);
  assert.ok(initialization < localeRead);
});
