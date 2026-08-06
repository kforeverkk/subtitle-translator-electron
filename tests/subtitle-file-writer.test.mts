import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WINDOWS_SUBTITLE_RENAME_RETRY_DELAYS_MS,
  writeSubtitleOutputAtomically,
} from "../electron/main/utils/subtitle-file-writer.ts";

function createFileSystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

async function createTemporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "subtitle-output-writer-")
  );
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("atomically replaces a subtitle from a unique same-directory temporary file", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const outputPath = path.join(directory, "movie.en.srt");
  await writeFile(outputPath, "last valid subtitle", "utf8");
  let temporaryPath = "";

  await writeSubtitleOutputAtomically(
    outputPath,
    "complete new subtitle",
    {
      renameFile: async (candidatePath, destinationPath) => {
        temporaryPath = candidatePath;
        await rename(candidatePath, destinationPath);
      },
    }
  );

  assert.equal(path.dirname(temporaryPath), directory);
  assert.match(
    path.basename(temporaryPath),
    /^movie\.en\.srt\.\d+\..+\.tmp$/
  );
  assert.equal(await readFile(outputPath, "utf8"), "complete new subtitle");
});

test("retries transient Windows rename failures before committing", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const outputPath = path.join(directory, "movie.en.srt");
  await writeFile(outputPath, "last valid subtitle", "utf8");
  const waits: number[] = [];
  let renameAttempts = 0;

  await writeSubtitleOutputAtomically(
    outputPath,
    "complete new subtitle",
    {
      platform: "win32",
      renameFile: async (temporaryPath, destinationPath) => {
        renameAttempts += 1;
        if (renameAttempts < 5) throw createFileSystemError("EPERM");
        await rename(temporaryPath, destinationPath);
      },
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    }
  );

  assert.equal(renameAttempts, 5);
  assert.deepEqual(waits, [25, 50, 100, 200]);
  assert.deepEqual(WINDOWS_SUBTITLE_RENAME_RETRY_DELAYS_MS, [
    25, 50, 100, 200,
  ]);
  assert.equal(await readFile(outputPath, "utf8"), "complete new subtitle");
});

test("preserves the last valid subtitle when Windows retries are exhausted", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const outputPath = path.join(directory, "movie.en.srt");
  await writeFile(outputPath, "last valid subtitle", "utf8");
  let renameAttempts = 0;
  let temporaryPath = "";

  await assert.rejects(
    writeSubtitleOutputAtomically(
      outputPath,
      "incomplete replacement",
      {
        platform: "win32",
        renameFile: async (candidatePath) => {
          temporaryPath = candidatePath;
          renameAttempts += 1;
          throw createFileSystemError("EPERM");
        },
        wait: async () => {},
      }
    ),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "EPERM"
  );

  assert.equal(renameAttempts, 5);
  assert.equal(await readFile(outputPath, "utf8"), "last valid subtitle");
  await assert.rejects(readFile(temporaryPath), {
    code: "ENOENT",
  });
});

test("does not retry deterministic or non-Windows rename failures", async (t) => {
  const directory = await createTemporaryDirectory(t);

  for (const [platform, code] of [
    ["win32", "ENOSPC"],
    ["linux", "EPERM"],
  ] as const) {
    const outputPath = path.join(directory, `${platform}.srt`);
    await writeFile(outputPath, `${platform} old subtitle`, "utf8");
    let renameAttempts = 0;

    await assert.rejects(
      writeSubtitleOutputAtomically(outputPath, "replacement", {
        platform,
        renameFile: async () => {
          renameAttempts += 1;
          throw createFileSystemError(code);
        },
        wait: async () => {
          assert.fail("non-retryable rename failure must not wait");
        },
      }),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === code
    );

    assert.equal(renameAttempts, 1);
    assert.equal(
      await readFile(outputPath, "utf8"),
      `${platform} old subtitle`
    );
  }
});

test("keeps the rename error when temporary cleanup also fails", async (t) => {
  const directory = await createTemporaryDirectory(t);
  const outputPath = path.join(directory, "movie.en.srt");
  await writeFile(outputPath, "last valid subtitle", "utf8");
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = originalWarn;
  });

  await assert.rejects(
    writeSubtitleOutputAtomically(outputPath, "replacement", {
      platform: "linux",
      renameFile: async () => {
        throw createFileSystemError("EPERM");
      },
      unlinkFile: async () => {
        throw createFileSystemError("EACCES");
      },
    }),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "EPERM"
  );

  assert.equal(await readFile(outputPath, "utf8"), "last valid subtitle");
});
