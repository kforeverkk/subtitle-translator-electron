import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as waitForTimeout } from "node:timers/promises";

const TRANSLATION_PIPELINE_VERSION = 2;
const translationTaskIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const WINDOWS_CHECKPOINT_RENAME_RETRY_DELAYS_MS = [
  25, 50, 100, 200,
] as const;

const transientWindowsRenameErrorCodes = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
]);

type RenameCheckpointFile = (
  temporaryPath: string,
  checkpointPath: string
) => Promise<void>;

export interface TranslationCheckpointAtomicWriteOptions {
  platform?: NodeJS.Platform;
  retryDelaysMs?: readonly number[];
  renameFile?: RenameCheckpointFile;
  wait?: (delayMs: number) => Promise<void>;
}

export type TranslationCheckpointWrite = (
  checkpointPath: string,
  content: string
) => Promise<void>;

function getFileSystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

export function isTranslationTaskId(value: unknown): value is string {
  return typeof value === "string" && translationTaskIdPattern.test(value);
}

function getCompactTranslationTaskId(taskId: string): string {
  if (!isTranslationTaskId(taskId)) {
    throw new Error("Invalid translation task ID");
  }
  return taskId.replaceAll("-", "").toLowerCase();
}

function isTransientWindowsRenameError(
  error: unknown,
  platform: NodeJS.Platform
): boolean {
  const code = getFileSystemErrorCode(error);
  return (
    platform === "win32" &&
    code !== undefined &&
    transientWindowsRenameErrorCodes.has(code)
  );
}

/**
 * Write a complete checkpoint beside the destination, flush it, and then
 * atomically replace the destination. A failed replacement never falls back
 * to truncating the last known-good checkpoint.
 */
export async function writeTranslationCheckpointAtomically(
  checkpointPath: string,
  content: string,
  options: TranslationCheckpointAtomicWriteOptions = {}
): Promise<void> {
  const temporaryPath = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
  const platform = options.platform ?? process.platform;
  const retryDelaysMs =
    options.retryDelaysMs ?? WINDOWS_CHECKPOINT_RENAME_RETRY_DELAYS_MS;
  const renameFile = options.renameFile ?? fs.promises.rename;
  const wait =
    options.wait ??
    (async (delayMs: number) => {
      await waitForTimeout(delayMs);
    });
  let committed = false;

  try {
    await fs.promises.writeFile(temporaryPath, content, {
      encoding: "utf8",
      flush: true,
    });

    let retryIndex = 0;
    while (true) {
      try {
        await renameFile(temporaryPath, checkpointPath);
        committed = true;
        return;
      } catch (error: unknown) {
        if (
          !isTransientWindowsRenameError(error, platform) ||
          retryIndex >= retryDelaysMs.length
        ) {
          throw error;
        }

        await wait(retryDelaysMs[retryIndex]);
        retryIndex += 1;
      }
    }
  } finally {
    if (!committed) {
      await fs.promises.unlink(temporaryPath).catch((error: unknown) => {
        if (getFileSystemErrorCode(error) !== "ENOENT") {
          console.warn(
            `Failed to remove temporary translation checkpoint: ${temporaryPath}`,
            error
          );
        }
      });
    }
  }
}

export function createCheckpointWriter<T>(
  checkpointPath: string,
  createDocument: () => T,
  writeCheckpoint: TranslationCheckpointWrite =
    writeTranslationCheckpointAtomically
): { write: () => Promise<void>; wait: () => Promise<void> } {
  let pending: Promise<void> = Promise.resolve();

  const write = () => {
    pending = pending
      .catch(() => undefined)
      .then(() =>
        writeCheckpoint(
          checkpointPath,
          `${JSON.stringify(createDocument(), null, 2)}\n`
        )
      );

    return pending;
  };

  return {
    write,
    wait: () => pending,
  };
}

export interface TranslationSourceFingerprint {
  size: number;
  mtimeMs: number;
  rawHash?: string;
  contentHash?: string;
  contentHashVersion?: number;
}

const sha256Pattern = /^[a-f\d]{64}$/i;

export function isCompleteTranslationSourceFingerprint(
  value: TranslationSourceFingerprint | undefined
): value is TranslationSourceFingerprint & {
  rawHash: string;
  contentHash: string;
  contentHashVersion: number;
} {
  return Boolean(
    value &&
      typeof value.rawHash === "string" &&
      sha256Pattern.test(value.rawHash) &&
      typeof value.contentHash === "string" &&
      sha256Pattern.test(value.contentHash) &&
      Number.isSafeInteger(value.contentHashVersion) &&
      (value.contentHashVersion ?? 0) >= 1
  );
}

export interface TranslationConfigIdentityInput {
  apiHost: string;
  model: string;
  prompt: string;
  lang: string;
  additional: string;
  temperature: number;
  contextSize: number;
}

interface CheckpointIdentity {
  version?: 1 | 2 | 3;
  format: string;
  source: {
    name: string;
    fingerprint?: TranslationSourceFingerprint;
  };
  translation?: {
    configFingerprint: string;
  };
  task?: {
    id: string;
  };
  analysis?: string;
}

export interface TranslationCheckpointResumeMetadata {
  analysis?: string;
  shouldBackupCheckpoint: boolean;
  shouldRestartTranslation: boolean;
}

export function createTranslationConfigFingerprint(
  config: TranslationConfigIdentityInput
): string {
  const stableConfig = [
    TRANSLATION_PIPELINE_VERSION,
    config.apiHost,
    config.model,
    config.prompt,
    config.lang,
    config.additional,
    config.temperature,
    config.contextSize,
  ];

  return createHash("sha256").update(JSON.stringify(stableConfig)).digest("hex");
}

export function hasMatchingCheckpointSource(
  checkpoint: CheckpointIdentity,
  sourceName: string,
  sourceExtension: string,
  sourceFingerprint: TranslationSourceFingerprint
): boolean {
  const checkpointFingerprint = checkpoint.source.fingerprint;
  return (
    checkpoint.source.name === sourceName &&
    checkpoint.format === sourceExtension &&
    checkpointFingerprint?.size === sourceFingerprint.size &&
    checkpointFingerprint.mtimeMs === sourceFingerprint.mtimeMs
  );
}

export function hasMatchingTranslationConfig(
  checkpoint: CheckpointIdentity,
  configFingerprint: string
): boolean {
  return checkpoint.translation?.configFingerprint === configFingerprint;
}

export function hasMatchingTranslationTask(
  checkpoint: CheckpointIdentity,
  taskId: string
): boolean {
  return checkpoint.version !== 3 || checkpoint.task?.id === taskId;
}

/**
 * Resume only when the checkpoint can prove that every content-affecting
 * translation setting is identical. Legacy checkpoints have no configuration
 * identity, so they must restart when used for a new translation request.
 */
export function getTranslationCheckpointResumeMetadata(
  checkpoint: CheckpointIdentity,
  configFingerprint?: string
): TranslationCheckpointResumeMetadata {
  const shouldRestartTranslation = Boolean(
    configFingerprint &&
      !hasMatchingTranslationConfig(checkpoint, configFingerprint)
  );

  return {
    analysis: shouldRestartTranslation ? undefined : checkpoint.analysis,
    shouldBackupCheckpoint: shouldRestartTranslation,
    shouldRestartTranslation,
  };
}

/**
 * Return the stable checkpoint name first, followed by the short-lived name
 * used by version 1.8.0 so both existing formats remain discoverable.
 */
export function getTranslationCheckpointCandidates(
  filePath: string,
  sourceName = path.basename(filePath)
): string[] {
  if (path.extname(filePath).toLowerCase() === ".json") {
    return [filePath];
  }

  const directory = path.dirname(filePath);
  const basename = path.basename(sourceName, path.extname(sourceName));
  return [
    path.join(directory, `${basename}.translation.json`),
    path.join(directory, `${sourceName}.translation.json`),
  ];
}

/**
 * New checkpoints are scoped to one logical renderer task. UUID hyphens are
 * omitted only in the filename to keep Windows paths a little shorter; the
 * full UUID remains in the checkpoint document.
 */
export function getTaskTranslationCheckpointPath(
  filePath: string,
  taskId: string,
  sourceName = path.basename(filePath)
): string {
  const compactTaskId = getCompactTranslationTaskId(taskId);
  if (path.extname(filePath).toLowerCase() === ".json") return filePath;

  const directory = path.dirname(filePath);
  const basename = path.basename(sourceName, path.extname(sourceName));
  return path.join(
    directory,
    `${basename}.translation.${compactTaskId}.json`
  );
}

/** Return only exact v3 task-checkpoint names, excluding backups and temp files. */
export function getDiscoveredTaskTranslationCheckpointPaths(
  filePath: string,
  directoryEntries: readonly string[],
  sourceName = path.basename(filePath)
): string[] {
  if (path.extname(filePath).toLowerCase() === ".json") return [];

  const basename = path.basename(sourceName, path.extname(sourceName));
  const prefix = `${basename}.translation.`;
  const suffix = ".json";
  return directoryEntries
    .filter((entry) => {
      if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return false;
      const compactTaskId = entry.slice(prefix.length, -suffix.length);
      return /^[0-9a-f]{32}$/i.test(compactTaskId);
    })
    .map((entry) => path.join(path.dirname(filePath), entry));
}

function createTranslationCheckpointBackupPath(
  checkpointPath: string,
  ownerTaskId: string
): string {
  return [
    checkpointPath,
    getCompactTranslationTaskId(ownerTaskId),
    Date.now(),
    randomUUID(),
    "backup.json",
  ].join(".");
}

export async function backupTranslationCheckpoint(
  checkpointPath: string,
  ownerTaskId: string
): Promise<string> {
  const backupPath = createTranslationCheckpointBackupPath(
    checkpointPath,
    ownerTaskId
  );
  await fs.promises.rename(checkpointPath, backupPath);
  return backupPath;
}

export async function copyTranslationCheckpointBackup(
  checkpointPath: string,
  ownerTaskId: string
): Promise<string> {
  const backupPath = createTranslationCheckpointBackupPath(
    checkpointPath,
    ownerTaskId
  );
  await fs.promises.copyFile(checkpointPath, backupPath);
  return backupPath;
}

export function getOwnedTranslationCheckpointBackupPaths(
  directory: string,
  directoryEntries: readonly string[],
  ownerTaskIds: readonly string[]
): string[] {
  const ownerPatterns = ownerTaskIds.map(
    (taskId) => {
      const ownerId = getCompactTranslationTaskId(taskId);
      const backupId =
        "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-" +
        "[89ab][0-9a-f]{3}-[0-9a-f]{12}";
      return new RegExp(
        `\\.json\\.${ownerId}\\.\\d+\\.${backupId}\\.backup\\.json$`,
        "i"
      );
    }
  );
  return directoryEntries
    .filter(
      (entry) =>
        ownerPatterns.some((ownerPattern) => ownerPattern.test(entry))
    )
    .map((entry) => path.join(directory, entry));
}

/** Remove only explicitly owned checkpoint artifacts; unrelated backups stay. */
export async function removeTranslationCheckpointArtifacts(
  checkpointPaths: readonly string[]
): Promise<void> {
  for (const checkpointPath of new Set(checkpointPaths)) {
    try {
      await fs.promises.unlink(checkpointPath);
    } catch (error: unknown) {
      if (getFileSystemErrorCode(error) !== "ENOENT") {
        console.warn(
          `Failed to remove translation checkpoint artifact: ${checkpointPath}`,
          error
        );
      }
    }
  }
}
