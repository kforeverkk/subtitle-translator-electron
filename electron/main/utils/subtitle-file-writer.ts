import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { setTimeout as waitForTimeout } from "node:timers/promises";

export const WINDOWS_SUBTITLE_RENAME_RETRY_DELAYS_MS = [
  25, 50, 100, 200,
] as const;

type RenameSubtitleFile = (
  temporaryPath: string,
  outputPath: string
) => Promise<void>;

type WriteSubtitleFile = (
  temporaryPath: string,
  content: string,
  options: { encoding: "utf8"; flush: true }
) => Promise<void>;

export interface SubtitleAtomicWriteOptions {
  platform?: NodeJS.Platform;
  retryDelaysMs?: readonly number[];
  renameFile?: RenameSubtitleFile;
  writeFile?: WriteSubtitleFile;
  unlinkFile?: (temporaryPath: string) => Promise<void>;
  wait?: (delayMs: number) => Promise<void>;
  createTemporaryPath?: (outputPath: string) => string;
}

function getFileSystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isTransientWindowsRenameError(
  error: unknown,
  platform: NodeJS.Platform
): boolean {
  const code = getFileSystemErrorCode(error);
  return (
    platform === "win32" &&
    (code === "EACCES" || code === "EBUSY" || code === "EPERM")
  );
}

/**
 * Commit a complete subtitle from a same-directory temporary file.
 * A failed rename never falls back to truncating the last valid output.
 */
export async function writeSubtitleOutputAtomically(
  outputPath: string,
  content: string,
  options: SubtitleAtomicWriteOptions = {}
): Promise<void> {
  const temporaryPath =
    options.createTemporaryPath?.(outputPath) ??
    `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  const platform = options.platform ?? process.platform;
  const retryDelaysMs =
    options.retryDelaysMs ?? WINDOWS_SUBTITLE_RENAME_RETRY_DELAYS_MS;
  const renameFile = options.renameFile ?? fs.promises.rename;
  const writeFile = options.writeFile ?? fs.promises.writeFile;
  const unlinkFile = options.unlinkFile ?? fs.promises.unlink;
  const wait =
    options.wait ??
    (async (delayMs: number) => {
      await waitForTimeout(delayMs);
    });
  let committed = false;

  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flush: true,
    });

    let retryIndex = 0;
    while (true) {
      try {
        await renameFile(temporaryPath, outputPath);
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
      await unlinkFile(temporaryPath).catch((error: unknown) => {
        if (getFileSystemErrorCode(error) !== "ENOENT") {
          console.warn(
            `Failed to remove temporary subtitle output: ${temporaryPath}`,
            error
          );
        }
      });
    }
  }
}
