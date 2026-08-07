# Defensive Settings Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect every existing persistent setting with a versioned local snapshot so a missing, malformed, legacy-encoded, or individually corrupted value can be recovered without resetting unrelated settings.

**Architecture:** Add one renderer-side settings storage module containing the protected-key registry, tolerant decoders, snapshot recovery, quarantine handling, and a runtime controller. Initialize it before locale activation in `src/main.tsx`, and route the explicit reset action through the controller so reset cannot be undone by a `pagehide` flush. Keep the existing `useLocalStorage` hooks and Electron user-data location unchanged.

**Tech Stack:** TypeScript 7, React 19, Electron 43, `usehooks-ts`, Node test runner, Playwright Electron E2E.

## Global Constraints

- Current valid values always win over snapshot values.
- Recover only the missing or invalid key; never replace unrelated valid settings.
- Accept standard JSON, legacy plain strings, and at most two JSON decoding layers.
- Protect `language`, API credentials/configuration, model, temperature, delay, RPM, concurrency, prompt, translation defaults, context size, output settings, fonts, output directory, and success count.
- Keep API keys only inside the existing application `localStorage`; never print setting values or snapshot contents.
- Explicit “reset all settings” must clear live values, snapshot, and quarantine without recreating the snapshot during `pagehide`.
- Do not add IPC, external settings files, registry entries, cloud synchronization, installer changes, or new dependencies.
- Automated E2E screenshot differences remain ignored and must not be staged.

---

### Task 1: Implement the pure protected-settings registry and recovery engine

**Files:**
- Create: `src/utils/settings-storage.ts`
- Create: `tests/settings-storage.test.mts`
- Modify: `package.json`

**Interfaces:**
- Produces:

```ts
export const SETTINGS_SNAPSHOT_KEY = "settings_snapshot_v1";
export const SETTINGS_QUARANTINE_KEY = "settings_quarantine_v1";

export const protectedSettingKeys = [
  "language",
  "api_keys",
  "api_host",
  "api_provider",
  "model",
  "ai_temperature",
  "delay",
  "requests_per_minute",
  "translation_concurrency",
  "prompt",
  "translate_lang",
  "translate_additional",
  "translate_context_size",
  "subtitle_output_format",
  "ass_translation_font",
  "ass_original_font",
  "translate_output_directory",
  "translation_success_count",
] as const;

export type ProtectedSettingKey = (typeof protectedSettingKeys)[number];

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

export interface SettingsSnapshotV1 {
  version: 1;
  updatedAt: string;
  values: Partial<Record<ProtectedSettingKey, string>>;
}

export interface SettingsRecoveryResult {
  recoveredKeys: ProtectedSettingKey[];
  normalizedKeys: ProtectedSettingKey[];
  quarantinedKeys: ProtectedSettingKey[];
}

export function normalizeProtectedSetting(
  key: ProtectedSettingKey,
  rawValue: string
): string | undefined;

export function recoverProtectedSettings(
  storage: SettingsStorage,
  now?: () => string
): SettingsRecoveryResult;

export function writeProtectedSettingsSnapshot(
  storage: SettingsStorage,
  now?: () => string
): void;
```

- Consumes:
  - `translationConcurrencyOptions` and `SubtitleOutputFormat` values from `src/types/electron-api.ts`.
  - `supportedLocales` from `src/utils/locale.ts`.
  - `normalizeTranslationSuccessCount` semantics from `src/utils/translation-success.ts`.

- [ ] **Step 1: Read the project test-quality rules before editing tests**

Read:

```text
C:\Users\kfore\.codex\plugins\cache\openai-curated-remote\superpowers\6.2.0\skills\test-driven-development\writing-good-tests.md
```

Confirm that each test names the production behavior that would make it fail and asserts returned/storage behavior rather than implementation details.

- [ ] **Step 2: Add the test file to the project test command**

Insert `tests/settings-storage.test.mts` in the `package.json` `test` script immediately after `tests/locale.test.mts`.

- [ ] **Step 3: Write the in-memory storage test helper and failing compatibility tests**

Create `tests/settings-storage.test.mts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  SETTINGS_QUARANTINE_KEY,
  SETTINGS_SNAPSHOT_KEY,
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
  assert.equal(normalizeProtectedSetting("translate_context_size", '"20"'), "20");
  assert.equal(normalizeProtectedSetting("requests_per_minute", "100001"), "100000");
});

test("rejects unsupported enum and structural values", () => {
  assert.equal(normalizeProtectedSetting("language", '"fr-FR"'), undefined);
  assert.equal(normalizeProtectedSetting("api_keys", '{"key":"secret"}'), undefined);
  assert.equal(normalizeProtectedSetting("subtitle_output_format", '"vtt"'), undefined);
  assert.equal(normalizeProtectedSetting("translation_concurrency", "3"), undefined);
});
```

- [ ] **Step 4: Run the compatibility tests and verify RED**

Run:

```powershell
pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/settings-storage.test.mts
```

Expected: FAIL because `src/utils/settings-storage.ts` does not exist.

- [ ] **Step 5: Add failing recovery-priority and isolation tests**

Append:

```ts
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
```

- [ ] **Step 6: Run the expanded tests and verify RED**

Run the Task 1 test command again.

Expected: FAIL because recovery and snapshot functions are still missing.

- [ ] **Step 7: Implement the setting registry and tolerant decoder**

Create `src/utils/settings-storage.ts` with:

```ts
import {
  translationConcurrencyOptions,
  type SubtitleOutputFormat,
} from "@/types/electron-api";
import { supportedLocales } from "@/utils/locale";
import { normalizeTranslationSuccessCount } from "@/utils/translation-success";

export const SETTINGS_SNAPSHOT_KEY = "settings_snapshot_v1";
export const SETTINGS_QUARANTINE_KEY = "settings_quarantine_v1";

export const protectedSettingKeys = [
  "language",
  "api_keys",
  "api_host",
  "api_provider",
  "model",
  "ai_temperature",
  "delay",
  "requests_per_minute",
  "translation_concurrency",
  "prompt",
  "translate_lang",
  "translate_additional",
  "translate_context_size",
  "subtitle_output_format",
  "ass_translation_font",
  "ass_original_font",
  "translate_output_directory",
  "translation_success_count",
] as const;

export type ProtectedSettingKey = (typeof protectedSettingKeys)[number];

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

export interface SettingsSnapshotV1 {
  version: 1;
  updatedAt: string;
  values: Partial<Record<ProtectedSettingKey, string>>;
}

export interface SettingsRecoveryResult {
  recoveredKeys: ProtectedSettingKey[];
  normalizedKeys: ProtectedSettingKey[];
  quarantinedKeys: ProtectedSettingKey[];
}

type Normalizer = (value: unknown) => unknown | undefined;

const apiProviders = [
  "openrouter",
  "openai",
  "vercel-gateway",
  "openai-compatible",
] as const;

const subtitleOutputFormats = [
  "srt-translation",
  "srt-bilingual",
  "srt-original-translation",
  "ass-bilingual",
  "ass-original-translation",
] as const satisfies readonly SubtitleOutputFormat[];

const stringValue: Normalizer = (value) =>
  typeof value === "string" ? value : undefined;

const finiteNumber = (
  fallbackMin: number,
  fallbackMax?: number,
  integer = false
): Normalizer => (value) => {
  const numberValue =
    typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return undefined;
  const rounded = integer ? Math.round(numberValue) : numberValue;
  return Math.min(
    fallbackMax ?? Number.POSITIVE_INFINITY,
    Math.max(fallbackMin, rounded)
  );
};

const registry: Record<ProtectedSettingKey, Normalizer> = {
  language: (value) =>
    typeof value === "string" &&
    (supportedLocales as readonly string[]).includes(value)
      ? value
      : undefined,
  api_keys: (value) =>
    Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : undefined,
  api_host: stringValue,
  api_provider: (value) =>
    typeof value === "string" &&
    (apiProviders as readonly string[]).includes(value)
      ? value
      : undefined,
  model: stringValue,
  ai_temperature: finiteNumber(0, 2),
  delay: finiteNumber(0),
  requests_per_minute: finiteNumber(1, 100_000, true),
  translation_concurrency: (value) => {
    const numberValue = typeof value === "number" ? value : Number(value);
    return translationConcurrencyOptions.includes(
      numberValue as (typeof translationConcurrencyOptions)[number]
    )
      ? numberValue
      : undefined;
  },
  prompt: stringValue,
  translate_lang: stringValue,
  translate_additional: stringValue,
  translate_context_size: finiteNumber(0, 100, true),
  subtitle_output_format: (value) =>
    typeof value === "string" &&
    (subtitleOutputFormats as readonly string[]).includes(value)
      ? value
      : undefined,
  ass_translation_font: stringValue,
  ass_original_font: stringValue,
  translate_output_directory: stringValue,
  translation_success_count: (value) => {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(numberValue) || numberValue < 0) return undefined;
    return normalizeTranslationSuccessCount(numberValue);
  },
};
```

Then implement candidate decoding:

```ts
function decodeCandidates(rawValue: string): unknown[] {
  const candidates: unknown[] = [];
  let current: unknown = rawValue;

  for (let depth = 0; depth < 2; depth++) {
    if (typeof current !== "string") break;
    try {
      current = JSON.parse(current);
      candidates.push(current);
    } catch {
      break;
    }
  }

  candidates.push(rawValue);
  return candidates;
}

export function normalizeProtectedSetting(
  key: ProtectedSettingKey,
  rawValue: string
): string | undefined {
  for (const candidate of decodeCandidates(rawValue)) {
    const normalized = registry[key](candidate);
    if (normalized !== undefined) return JSON.stringify(normalized);
  }
  return undefined;
}
```

- [ ] **Step 8: Implement snapshot parsing, recovery, quarantine, and writes**

Add internal snapshot parsing that accepts only `version === 1`, string values, and registered keys. Implement `recoverProtectedSettings` with live-value priority and per-key `try/catch`. Implement `writeProtectedSettingsSnapshot` so it starts with the last valid snapshot and overwrites only keys that currently have valid live values:

```ts
const previousSnapshot = readSettingsSnapshot(storage);
const values: Partial<Record<ProtectedSettingKey, string>> = {
  ...(previousSnapshot?.values ?? {}),
};
for (const key of protectedSettingKeys) {
  const rawValue = storage.getItem(key);
  if (rawValue === null) continue;
  const normalizedValue = normalizeProtectedSetting(key, rawValue);
  if (normalizedValue !== undefined) values[key] = normalizedValue;
}
storage.setItem(
  SETTINGS_SNAPSHOT_KEY,
  JSON.stringify({ version: 1, updatedAt: now(), values })
);
```

Missing or invalid live values must not delete a last-known-good snapshot entry. Recovery must restore only invalid/missing keys from a valid old snapshot, quarantine unrecoverable raw strings, and never include raw values in thrown or logged errors.

- [ ] **Step 9: Add failing tests for API credentials, snapshot refresh, and storage errors**

Append:

```ts
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
```

- [ ] **Step 10: Run Task 1 tests and verify GREEN**

Run the Task 1 test command.

Expected: all settings-storage tests pass.

- [ ] **Step 11: Run locale, success-count, and Task 1 regression tests**

Run:

```powershell
pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/locale.test.mts tests/settings-storage.test.mts tests/translation-success.test.mts
```

Expected: all selected tests pass.

- [ ] **Step 12: Commit Task 1**

Stage only:

```text
src/utils/settings-storage.ts
tests/settings-storage.test.mts
package.json
```

Commit:

```text
feat: add defensive settings recovery
```

---

### Task 2: Initialize protection before locale activation and make reset final

**Files:**
- Modify: `src/utils/settings-storage.ts`
- Modify: `src/main.tsx`
- Modify: `src/pages/settings.tsx`
- Modify: `tests/settings-storage.test.mts`

**Interfaces:**
- Produces:

```ts
export interface SettingsEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface SettingsProtectionController {
  flush(): void;
  reset(): void;
  dispose(): void;
}

export function startSettingsProtection(
  storage: SettingsStorage,
  eventTarget: SettingsEventTarget,
  now?: () => string
): SettingsProtectionController;

export function initializeSettingsProtection(
  storage?: SettingsStorage,
  eventTarget?: SettingsEventTarget
): SettingsProtectionController;

export function resetProtectedSettings(
  storage?: SettingsStorage
): void;
```

- Consumes:
  - Task 1 recovery and snapshot functions.
  - `window.localStorage` and `window` in production.

- [ ] **Step 1: Write failing controller tests**

Extend the test helper with a real `EventTarget`, then append:

```ts
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
```

- [ ] **Step 2: Run controller tests and verify RED**

Run the Task 1 test command.

Expected: FAIL because `startSettingsProtection` is not exported.

- [ ] **Step 3: Implement the runtime controller**

Implement `startSettingsProtection` with these exact behaviors:

```ts
export function startSettingsProtection(
  storage: SettingsStorage,
  eventTarget: SettingsEventTarget,
  now: () => string = () => new Date().toISOString()
): SettingsProtectionController {
  let disposed = false;
  let resetRequested = false;
  let flushScheduled = false;

  recoverProtectedSettings(storage, now);

  const flush = () => {
    if (disposed || resetRequested) return;
    writeProtectedSettingsSnapshot(storage, now);
  };

  const scheduleFlush = () => {
    if (disposed || resetRequested || flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      flush();
    });
  };

  const onStorageChange: EventListener = () => scheduleFlush();
  const onPageHide: EventListener = () => flush();

  eventTarget.addEventListener("local-storage", onStorageChange);
  eventTarget.addEventListener("storage", onStorageChange);
  eventTarget.addEventListener("pagehide", onPageHide);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    eventTarget.removeEventListener("local-storage", onStorageChange);
    eventTarget.removeEventListener("storage", onStorageChange);
    eventTarget.removeEventListener("pagehide", onPageHide);
  };

  return {
    flush,
    dispose,
    reset() {
      if (resetRequested) return;
      resetRequested = true;
      dispose();
      storage.clear();
    },
  };
}
```

Add a module-level active controller:

```ts
let activeSettingsProtection: SettingsProtectionController | undefined;

export function initializeSettingsProtection(
  storage: SettingsStorage = window.localStorage,
  eventTarget: SettingsEventTarget = window
): SettingsProtectionController {
  activeSettingsProtection?.dispose();
  activeSettingsProtection = startSettingsProtection(storage, eventTarget);
  return activeSettingsProtection;
}

export function resetProtectedSettings(
  storage: SettingsStorage = window.localStorage
): void {
  if (activeSettingsProtection) {
    activeSettingsProtection.reset();
    activeSettingsProtection = undefined;
    return;
  }
  storage.clear();
}
```

- [ ] **Step 4: Run controller tests and verify GREEN**

Run the Task 1 test command.

Expected: all settings-storage tests pass.

- [ ] **Step 5: Add a failing test for startup ordering**

Append a source-level regression test to `tests/settings-storage.test.mts`:

```ts
import { readFileSync } from "node:fs";

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
```

Run the focused settings-storage test.

Expected: FAIL because `src/main.tsx` does not yet initialize settings protection.

- [ ] **Step 6: Initialize settings protection before reading the locale**

In `src/main.tsx`, import and call:

```ts
import { initializeSettingsProtection } from "./utils/settings-storage";

initializeSettingsProtection(localStorage, window);
const initialLocale = parseStoredLocale(localStorage.getItem("language"));
```

The initialization call must remain immediately before `initialLocale`, ensuring recovered or normalized language is visible to Lingui and native-menu synchronization.

- [ ] **Step 7: Route explicit reset through the protection controller**

In `src/pages/settings.tsx`, import:

```ts
import { resetProtectedSettings } from "@/utils/settings-storage";
```

Replace:

```ts
localStorage.clear();
```

with:

```ts
resetProtectedSettings(localStorage);
```

Keep the existing confirmation and `window.location.reload()`.

- [ ] **Step 8: Run the startup-order test and verify GREEN**

Run the focused settings-storage test.

Expected: PASS because recovery now starts before the initial locale read.

- [ ] **Step 9: Run focused tests and type checking**

Run:

```powershell
pnpm exec node --import ./tests/typescript-module-resolver.mjs --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/locale.test.mts tests/settings-storage.test.mts
pnpm run typecheck
```

Expected: all focused tests and both TypeScript configurations pass.

- [ ] **Step 10: Commit Task 2**

Stage only:

```text
src/utils/settings-storage.ts
src/main.tsx
src/pages/settings.tsx
tests/settings-storage.test.mts
```

Commit:

```text
fix: recover protected settings before startup
```

---

### Task 3: Add real Electron recovery, priority, restart, and reset coverage

**Files:**
- Modify: `e2e/example.spec.ts`

**Interfaces:**
- Consumes:
  - `SETTINGS_SNAPSHOT_KEY` and protected-setting behavior through the built renderer.
  - Existing shared `isolatedE2eUserDataDirectory`.

- [ ] **Step 1: Add a GUI acceptance test for restoring missing and malformed live settings**

Add after the existing locale/menu E2E test:

```ts
test("settings snapshot restores only missing or malformed preferences", async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("language", JSON.stringify("zh-CN"));
      localStorage.setItem("api_keys", JSON.stringify(["snapshot-test-key"]));
      localStorage.setItem(
        "api_host",
        JSON.stringify("https://snapshot-test.invalid/v1")
      );
      localStorage.setItem("requests_per_minute", JSON.stringify(321));
      localStorage.setItem("translate_context_size", JSON.stringify(27));
      localStorage.setItem("model", JSON.stringify("current-model"));
      window.dispatchEvent(new StorageEvent("local-storage", { key: "model" }));
    });
    await page.waitForFunction(
      () => localStorage.getItem("settings_snapshot_v1") !== null
    );
    await page.reload();

    await page.evaluate(() => {
      localStorage.removeItem("language");
      localStorage.setItem("translate_context_size", "{broken");
      localStorage.setItem("model", JSON.stringify("newer-model"));
    });
    await page.reload();

    const values = await page.evaluate(() => ({
      language: localStorage.getItem("language"),
      apiKeys: localStorage.getItem("api_keys"),
      apiHost: localStorage.getItem("api_host"),
      rpm: localStorage.getItem("requests_per_minute"),
      contextSize: localStorage.getItem("translate_context_size"),
      model: localStorage.getItem("model"),
    }));
    expect(values).toEqual({
      language: JSON.stringify("zh-CN"),
      apiKeys: JSON.stringify(["snapshot-test-key"]),
      apiHost: JSON.stringify("https://snapshot-test.invalid/v1"),
      rpm: JSON.stringify(321),
      contextSize: JSON.stringify(27),
      model: JSON.stringify("newer-model"),
    });

    await expect(
      page.locator("button").filter({ hasText: /^设定$/ }).first()
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Run only the new GUI recovery test**

Run:

```powershell
pnpm run pree2e
pnpm exec playwright test e2e/example.spec.ts --grep "settings snapshot restores only missing or malformed preferences"
```

Expected: PASS.

- [ ] **Step 3: Add a process-restart recovery test**

Add:

```ts
test("protected settings survive a full Electron process restart", async () => {
  const firstApp = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const firstPage = await firstApp.firstWindow();
    await firstPage.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("language", JSON.stringify("zh-CN"));
      localStorage.setItem("requests_per_minute", JSON.stringify(456));
      localStorage.setItem("translate_context_size", JSON.stringify(33));
      localStorage.setItem("subtitle_output_format", JSON.stringify("ass-bilingual"));
      window.dispatchEvent(
        new StorageEvent("local-storage", { key: "subtitle_output_format" })
      );
    });
    await firstPage.waitForFunction(
      () => localStorage.getItem("settings_snapshot_v1") !== null
    );
    await firstPage.evaluate(() => {
      localStorage.removeItem("translate_context_size");
    });
  } finally {
    await firstApp.close();
  }

  const secondApp = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const secondPage = await secondApp.firstWindow();
    const values = await secondPage.evaluate(() => ({
      language: localStorage.getItem("language"),
      rpm: localStorage.getItem("requests_per_minute"),
      contextSize: localStorage.getItem("translate_context_size"),
      outputFormat: localStorage.getItem("subtitle_output_format"),
    }));
    expect(values).toEqual({
      language: JSON.stringify("zh-CN"),
      rpm: JSON.stringify(456),
      contextSize: JSON.stringify(33),
      outputFormat: JSON.stringify("ass-bilingual"),
    });
  } finally {
    await secondApp.close();
  }
});
```

The first process deliberately removes the live context-size key after the snapshot exists. Its `pagehide` flush must retain the last valid snapshot, and the second process must restore the value to `33`.

- [ ] **Step 4: Add explicit reset coverage**

Add:

```ts
test("reset all clears the live settings and defensive snapshot", async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("language", JSON.stringify("en-US"));
      localStorage.setItem("requests_per_minute", JSON.stringify(999));
      window.dispatchEvent(
        new StorageEvent("local-storage", { key: "requests_per_minute" })
      );
    });
    await page.waitForFunction(
      () => localStorage.getItem("settings_snapshot_v1") !== null
    );
    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reset" }).click();
    await page.waitForLoadState("domcontentloaded");

    const values = await page.evaluate(() => ({
      rpm: localStorage.getItem("requests_per_minute"),
      snapshot: localStorage.getItem("settings_snapshot_v1"),
      quarantine: localStorage.getItem("settings_quarantine_v1"),
    }));
    expect(values).toEqual({
      rpm: null,
      snapshot: null,
      quarantine: null,
    });
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 5: Run all three focused settings E2E tests**

Run:

```powershell
pnpm exec playwright test e2e/example.spec.ts --grep "settings snapshot|protected settings survive|reset all clears"
```

Expected: all focused tests pass.

- [ ] **Step 6: Run the complete validation suite**

Run:

```powershell
pnpm install --frozen-lockfile --offline
pnpm run check
pnpm run e2e
```

Expected:

- TypeScript checks pass.
- All existing and new unit tests pass.
- All runnable Electron E2E tests pass; only platform-conditional tests may skip.
- The only unrelated working-tree difference remains `e2e/screenshots/example.png`.

- [ ] **Step 7: Inspect the complete diff and security boundaries**

Run:

```powershell
git diff --check
git diff -- src/utils/settings-storage.ts src/main.tsx src/pages/settings.tsx tests/settings-storage.test.mts e2e/example.spec.ts package.json
git status --short
```

Confirm:

- No log includes raw values.
- Current live values override snapshot values.
- API keys are stored only in live localStorage and the local snapshot.
- Reset disables listeners before clearing.
- No external file, IPC, dependency, installer, screenshot, or unrelated source change is included.

- [ ] **Step 8: Commit Task 3**

Stage only:

```text
e2e/example.spec.ts
```

Never stage `e2e/screenshots/example.png`.

Commit:

```text
test: cover defensive settings recovery
```

---

## Final Acceptance Checklist

- [ ] Every new production function was preceded by a failing test.
- [ ] Standard, plain, and double-serialized values are compatible.
- [ ] Valid live settings always win.
- [ ] Missing or malformed individual settings recover from the snapshot.
- [ ] Unrecoverable values are quarantined without affecting siblings.
- [ ] API keys are protected without being logged.
- [ ] Context size, language, API configuration, RPM, and output settings survive process restart.
- [ ] Explicit reset cannot be undone by scheduled or `pagehide` snapshot writes.
- [ ] Full unit, type, and Electron GUI suites pass.
- [ ] Automated screenshot differences remain uncommitted.
