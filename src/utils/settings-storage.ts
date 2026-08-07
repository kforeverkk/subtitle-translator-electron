import {
  translationConcurrencyOptions,
  type SubtitleOutputFormat,
} from "../types/electron-api";
import { supportedLocales } from "./locale";
import { normalizeTranslationSuccessCount } from "./translation-success";

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

interface SettingsQuarantineV1 {
  version: 1;
  updatedAt: string;
  values: Partial<Record<ProtectedSettingKey, string>>;
}

export interface SettingsRecoveryResult {
  recoveredKeys: ProtectedSettingKey[];
  normalizedKeys: ProtectedSettingKey[];
  quarantinedKeys: ProtectedSettingKey[];
}

export interface SettingsEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface SettingsProtectionController {
  flush(): void;
  reset(): void;
  dispose(): void;
}

type Normalizer = (value: unknown) => unknown | undefined;

const protectedSettingKeySet = new Set<string>(protectedSettingKeys);
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

function finiteNumber(
  minimum: number,
  maximum?: number,
  integer = false
): Normalizer {
  return (value) => {
    const numericValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numericValue)) return undefined;

    const normalizedValue = integer ? Math.round(numericValue) : numericValue;
    return Math.min(
      maximum ?? Number.POSITIVE_INFINITY,
      Math.max(minimum, normalizedValue)
    );
  };
}

const settingNormalizers: Record<ProtectedSettingKey, Normalizer> = {
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
    const numericValue = typeof value === "number" ? value : Number(value);
    return translationConcurrencyOptions.includes(
      numericValue as (typeof translationConcurrencyOptions)[number]
    )
      ? numericValue
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
    const numericValue = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(numericValue) || numericValue < 0) {
      return undefined;
    }
    return normalizeTranslationSuccessCount(numericValue);
  },
};

function decodeCandidates(rawValue: string): unknown[] {
  const candidates: unknown[] = [];
  let currentValue: unknown = rawValue;

  for (let depth = 0; depth < 2; depth++) {
    if (typeof currentValue !== "string") break;
    try {
      currentValue = JSON.parse(currentValue);
      candidates.push(currentValue);
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
    const normalizedValue = settingNormalizers[key](candidate);
    if (normalizedValue !== undefined) {
      return JSON.stringify(normalizedValue);
    }
  }
  return undefined;
}

function readStorageValue(
  storage: SettingsStorage,
  key: string
): string | null | undefined {
  try {
    return storage.getItem(key);
  } catch {
    return undefined;
  }
}

function writeStorageValue(
  storage: SettingsStorage,
  key: string,
  value: string
): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorageValue(storage: SettingsStorage, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readVersionedValues(
  storage: SettingsStorage,
  storageKey: string,
  validateValues: boolean
): Partial<Record<ProtectedSettingKey, string>> | undefined {
  const rawDocument = readStorageValue(storage, storageKey);
  if (!rawDocument) return undefined;

  try {
    const parsedDocument: unknown = JSON.parse(rawDocument);
    if (
      typeof parsedDocument !== "object" ||
      parsedDocument === null ||
      (parsedDocument as { version?: unknown }).version !== 1
    ) {
      return undefined;
    }

    const rawValues = (parsedDocument as { values?: unknown }).values;
    if (typeof rawValues !== "object" || rawValues === null) return undefined;

    const values: Partial<Record<ProtectedSettingKey, string>> = {};
    for (const [key, rawValue] of Object.entries(rawValues)) {
      if (!protectedSettingKeySet.has(key) || typeof rawValue !== "string") {
        continue;
      }

      const settingKey = key as ProtectedSettingKey;
      if (!validateValues) {
        values[settingKey] = rawValue;
        continue;
      }

      const normalizedValue = normalizeProtectedSetting(settingKey, rawValue);
      if (normalizedValue !== undefined) {
        values[settingKey] = normalizedValue;
      }
    }
    return values;
  } catch {
    return undefined;
  }
}

function readSettingsSnapshot(
  storage: SettingsStorage
): SettingsSnapshotV1 | undefined {
  const values = readVersionedValues(storage, SETTINGS_SNAPSHOT_KEY, true);
  return values
    ? {
        version: 1,
        updatedAt: "",
        values,
      }
    : undefined;
}

function readSettingsQuarantine(
  storage: SettingsStorage
): SettingsQuarantineV1 | undefined {
  const values = readVersionedValues(storage, SETTINGS_QUARANTINE_KEY, false);
  return values
    ? {
        version: 1,
        updatedAt: "",
        values,
      }
    : undefined;
}

function writeSnapshotDocument(
  storage: SettingsStorage,
  values: Partial<Record<ProtectedSettingKey, string>>,
  now: () => string
): void {
  if (Object.keys(values).length === 0) {
    removeStorageValue(storage, SETTINGS_SNAPSHOT_KEY);
    return;
  }

  writeStorageValue(
    storage,
    SETTINGS_SNAPSHOT_KEY,
    JSON.stringify({
      version: 1,
      updatedAt: now(),
      values,
    } satisfies SettingsSnapshotV1)
  );
}

function mergeCurrentProtectedSettings(
  storage: SettingsStorage,
  previousValues: Partial<Record<ProtectedSettingKey, string>>
): Partial<Record<ProtectedSettingKey, string>> {
  const values: Partial<Record<ProtectedSettingKey, string>> = {
    ...previousValues,
  };

  for (const key of protectedSettingKeys) {
    const rawValue = readStorageValue(storage, key);
    if (rawValue === null || rawValue === undefined) continue;

    const normalizedValue = normalizeProtectedSetting(key, rawValue);
    if (normalizedValue !== undefined) {
      values[key] = normalizedValue;
    }
  }

  return values;
}

export function writeProtectedSettingsSnapshot(
  storage: SettingsStorage,
  now: () => string = () => new Date().toISOString()
): void {
  const previousSnapshot = readSettingsSnapshot(storage);
  const values = mergeCurrentProtectedSettings(
    storage,
    previousSnapshot?.values ?? {}
  );

  writeSnapshotDocument(storage, values, now);
}

export function recoverProtectedSettings(
  storage: SettingsStorage,
  now: () => string = () => new Date().toISOString()
): SettingsRecoveryResult {
  const snapshotValues = readSettingsSnapshot(storage)?.values ?? {};
  const snapshotOutput: Partial<Record<ProtectedSettingKey, string>> = {
    ...snapshotValues,
  };
  const quarantineValues: Partial<Record<ProtectedSettingKey, string>> = {
    ...(readSettingsQuarantine(storage)?.values ?? {}),
  };
  const recoveredKeys: ProtectedSettingKey[] = [];
  const normalizedKeys: ProtectedSettingKey[] = [];
  const quarantinedKeys: ProtectedSettingKey[] = [];

  for (const key of protectedSettingKeys) {
    const rawValue = readStorageValue(storage, key);
    if (rawValue === undefined) continue;

    const snapshotValue = snapshotValues[key];
    if (rawValue === null) {
      if (
        snapshotValue !== undefined &&
        writeStorageValue(storage, key, snapshotValue)
      ) {
        recoveredKeys.push(key);
      }
      continue;
    }

    const normalizedValue = normalizeProtectedSetting(key, rawValue);
    if (normalizedValue !== undefined) {
      snapshotOutput[key] = normalizedValue;
      if (
        normalizedValue !== rawValue &&
        writeStorageValue(storage, key, normalizedValue)
      ) {
        normalizedKeys.push(key);
      }
      continue;
    }

    if (
      snapshotValue !== undefined &&
      writeStorageValue(storage, key, snapshotValue)
    ) {
      recoveredKeys.push(key);
      continue;
    }

    quarantineValues[key] = rawValue;
    if (removeStorageValue(storage, key)) {
      quarantinedKeys.push(key);
    }
  }

  writeSnapshotDocument(storage, snapshotOutput, now);
  if (quarantinedKeys.length > 0) {
    writeStorageValue(
      storage,
      SETTINGS_QUARANTINE_KEY,
      JSON.stringify({
        version: 1,
        updatedAt: now(),
        values: quarantineValues,
      } satisfies SettingsQuarantineV1)
    );
  }

  return {
    recoveredKeys,
    normalizedKeys,
    quarantinedKeys,
  };
}

export function startSettingsProtection(
  storage: SettingsStorage,
  eventTarget: SettingsEventTarget,
  now: () => string = () => new Date().toISOString()
): SettingsProtectionController {
  let disposed = false;
  let resetRequested = false;
  let flushScheduled = false;

  recoverProtectedSettings(storage, now);
  let lastKnownSnapshotValues = readSettingsSnapshot(storage)?.values ?? {};

  const flush = () => {
    if (disposed || resetRequested) return;
    lastKnownSnapshotValues = mergeCurrentProtectedSettings(
      storage,
      lastKnownSnapshotValues
    );
    writeSnapshotDocument(storage, lastKnownSnapshotValues, now);
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
