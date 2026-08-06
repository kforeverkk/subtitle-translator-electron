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
  createSubtitleOutputWriter,
  writeFinalSubtitleOutput,
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

test("serial subtitle writer commits snapshots in enqueue order", async () => {
  const started: string[] = [];
  const completed: string[] = [];
  let releaseFirstWrite: (() => void) | undefined;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  const writer = createSubtitleOutputWriter(
    "movie.en.srt",
    async (_outputPath, content) => {
      started.push(content);
      if (content === "snapshot A") {
        await firstWriteGate;
      }
      completed.push(content);
    }
  );

  const first = writer.write("snapshot A");
  await Promise.resolve();
  const second = writer.write("snapshot B");
  await Promise.resolve();

  assert.deepEqual(started, ["snapshot A"]);
  releaseFirstWrite?.();
  await Promise.all([first, second]);

  assert.deepEqual(started, ["snapshot A", "snapshot B"]);
  assert.deepEqual(completed, ["snapshot A", "snapshot B"]);
});

test("serial subtitle writer recovers after one failed write", async () => {
  const attempted: string[] = [];
  const writer = createSubtitleOutputWriter(
    "movie.en.srt",
    async (_outputPath, content) => {
      attempted.push(content);
      if (content === "failed partial snapshot") {
        throw createFileSystemError("EPERM");
      }
    }
  );

  const failedWrite = writer.write("failed partial snapshot");
  const recoveredWrite = writer.write("latest complete snapshot");

  await assert.rejects(failedWrite, {
    code: "EPERM",
  });
  await recoveredWrite;
  await writer.wait();

  assert.deepEqual(attempted, [
    "failed partial snapshot",
    "latest complete snapshot",
  ]);
});

test("final subtitle output waits for partial work and requires a fresh commit", async () => {
  const committed: string[] = [];
  let releasePartialWrite: (() => void) | undefined;
  const partialGate = new Promise<void>((resolve) => {
    releasePartialWrite = resolve;
  });
  const writer = createSubtitleOutputWriter(
    "movie.en.srt",
    async (_outputPath, content) => {
      if (content === "partial snapshot") {
        await partialGate;
      }
      committed.push(content);
    }
  );

  const partialWrite = writer.write("partial snapshot");
  const finalWrite = writeFinalSubtitleOutput(writer, "final snapshot");
  await Promise.resolve();

  assert.deepEqual(committed, []);
  releasePartialWrite?.();
  await Promise.all([partialWrite, finalWrite]);
  assert.deepEqual(committed, ["partial snapshot", "final snapshot"]);
});

test("final subtitle output rejects when its mandatory commit fails", async () => {
  const writer = createSubtitleOutputWriter(
    "movie.en.srt",
    async (_outputPath, content) => {
      if (content === "final snapshot") {
        throw createFileSystemError("EPERM");
      }
    }
  );

  await writer.write("partial snapshot");
  await assert.rejects(
    writeFinalSubtitleOutput(writer, "final snapshot"),
    { code: "EPERM" }
  );
});
