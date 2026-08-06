import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import path from "node:path";
import {
  backupTranslationCheckpoint,
  copyTranslationCheckpointBackup,
  createCheckpointWriter,
  createTranslationConfigFingerprint,
  getDiscoveredTaskTranslationCheckpointPaths,
  getOwnedTranslationCheckpointBackupPaths,
  getTaskTranslationCheckpointPath,
  getTranslationCheckpointCandidates,
  getTranslationCheckpointResumeMetadata,
  hasMatchingTranslationConfig,
  hasMatchingTranslationTask,
  isTranslationTaskId,
  removeTranslationCheckpointArtifacts,
  writeTranslationCheckpointAtomically,
} from "../electron/main/utils/translation-checkpoint.ts";
import { clearSubtitleCueTranslations } from "../electron/main/utils/subtitle-chunks.ts";
import { parseTranslationCache } from "../electron/main/utils/translate.ts";

const fingerprint = { size: 1_024, mtimeMs: 123_456.75 };
const taskId = "11111111-1111-4111-8111-111111111111";
const otherTaskId = "22222222-2222-4222-8222-222222222222";

function createFileSystemError(code: string): NodeJS.ErrnoException {
  const error = new Error(`Simulated file system error: ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function createCheckpointTestDirectory(
  context: TestContext
): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "subtitle-translator-checkpoint-")
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("accepts complete source hashes and rejects partial or malformed hash metadata", () => {
  const validDocument = {
    version: 3,
    format: "srt",
    source: {
      name: "episode.srt",
      fingerprint: {
        ...fingerprint,
        rawHash: "a".repeat(64),
        contentHash: "b".repeat(64),
        contentHashVersion: 1,
      },
    },
    translation: { configFingerprint: "c".repeat(64) },
    task: { id: taskId },
    subtitle: [
      {
        type: "cue",
        data: { start: 0, end: 1_000, text: "Hello" },
      },
    ],
  };

  assert.deepEqual(
    parseTranslationCache(JSON.stringify(validDocument)),
    validDocument
  );
  for (const fingerprintOverride of [
    { ...validDocument.source.fingerprint, contentHash: undefined },
    { ...validDocument.source.fingerprint, rawHash: "not-a-hash" },
    { ...validDocument.source.fingerprint, contentHashVersion: 0 },
  ]) {
    assert.throws(() =>
      parseTranslationCache(
        JSON.stringify({
          ...validDocument,
          source: { ...validDocument.source, fingerprint: fingerprintOverride },
        })
      )
    );
  }
});

test("accepts a safe output identity and keeps older checkpoints compatible", () => {
  const baseDocument = {
    version: 3,
    format: "srt",
    source: { name: "episode.srt", fingerprint },
    translation: { configFingerprint: "c".repeat(64) },
    task: { id: taskId },
    subtitle: [
      {
        type: "cue",
        data: { start: 0, end: 1_000, text: "Hello" },
      },
    ],
  };
  const output = {
    format: "srt-bilingual",
    detectedSourceLanguage: "Chinese",
    fileName: "episode.en-zh.srt",
  };

  assert.deepEqual(
    parseTranslationCache(JSON.stringify({ ...baseDocument, output })),
    { ...baseDocument, output }
  );
  assert.deepEqual(
    parseTranslationCache(JSON.stringify(baseDocument)),
    baseDocument
  );
});

test("rejects unsafe checkpoint output identities", () => {
  const baseDocument = {
    version: 3,
    format: "srt",
    source: { name: "episode.srt", fingerprint },
    translation: { configFingerprint: "c".repeat(64) },
    task: { id: taskId },
    subtitle: [
      {
        type: "cue",
        data: { start: 0, end: 1_000, text: "Hello" },
      },
    ],
  };

  for (const output of [
    {
      format: "srt-bilingual",
      detectedSourceLanguage: "Chinese",
      fileName: "../episode.en-zh.srt",
    },
    {
      format: "srt-bilingual",
      detectedSourceLanguage: "Chinese",
      fileName: "episode.en-zh.ass",
    },
    {
      format: "srt-bilingual",
      detectedSourceLanguage: 1,
      fileName: "episode.en-zh.srt",
    },
  ]) {
    assert.throws(
      () => parseTranslationCache(JSON.stringify({ ...baseDocument, output })),
      /ERR_INCOMPATIBLE_TRANSLATION_CHECKPOINT/
    );
  }
});

test("identifies whether the translation configuration matches", () => {
  const config = {
    apiHost: "https://api.openai.com/v1",
    model: "example-model",
    prompt: "Translate to {{lang}}",
    lang: "Traditional Chinese",
    additional: "Keep names consistent",
    temperature: 0.3,
    contextSize: 5,
  };
  const configFingerprint = createTranslationConfigFingerprint(config);
  const checkpoint = {
    format: "srt",
    source: { name: "episode.srt", fingerprint },
    translation: { configFingerprint },
  };

  assert.equal(
    hasMatchingTranslationConfig(checkpoint, configFingerprint),
    true
  );
  assert.equal(
    hasMatchingTranslationConfig(
      checkpoint,
      createTranslationConfigFingerprint({ ...config, lang: "Japanese" })
    ),
    false
  );
  assert.equal(
    hasMatchingTranslationConfig(
      { format: "srt", source: { name: "episode.srt", fingerprint } },
      configFingerprint
    ),
    false
  );

  const changedContentConfigurations: Array<[string, typeof config]> = [
    ["API host", { ...config, apiHost: "https://example.com/v1" }],
    ["model", { ...config, model: "another-model" }],
    ["prompt", { ...config, prompt: "Use a different prompt" }],
    ["target language", { ...config, lang: "Japanese" }],
    ["additional instructions", { ...config, additional: "Be concise" }],
    ["temperature", { ...config, temperature: 0.7 }],
    ["context size", { ...config, contextSize: 10 }],
  ];
  for (const [setting, changedConfig] of changedContentConfigurations) {
    assert.notEqual(
      createTranslationConfigFingerprint(changedConfig),
      configFingerprint,
      `${setting} must invalidate the checkpoint`
    );
  }
});

test("restarts translation and invalidates analysis when settings change", () => {
  const checkpoint = {
    version: 2 as const,
    format: "srt",
    source: { name: "episode.srt", fingerprint },
    translation: { configFingerprint: "a".repeat(64) },
    analysis: "Existing context",
  };

  assert.deepEqual(
    getTranslationCheckpointResumeMetadata(checkpoint, "b".repeat(64)),
    {
      analysis: undefined,
      shouldBackupCheckpoint: true,
      shouldRestartTranslation: true,
    }
  );
  assert.deepEqual(
    getTranslationCheckpointResumeMetadata(checkpoint, "a".repeat(64)),
    {
      analysis: "Existing context",
      shouldBackupCheckpoint: false,
      shouldRestartTranslation: false,
    }
  );
});

test("resumes matching v2 and v3 checkpoints while keeping task identity separate", () => {
  const configFingerprint = "a".repeat(64);
  const version2Checkpoint = {
    version: 2 as const,
    format: "srt",
    source: { name: "episode.srt", fingerprint },
    translation: { configFingerprint },
    analysis: "v2 context",
  };
  const version3Checkpoint = {
    ...version2Checkpoint,
    version: 3 as const,
    task: { id: taskId },
    analysis: "v3 context",
  };

  assert.deepEqual(
    getTranslationCheckpointResumeMetadata(
      version2Checkpoint,
      configFingerprint
    ),
    {
      analysis: "v2 context",
      shouldBackupCheckpoint: false,
      shouldRestartTranslation: false,
    }
  );
  assert.deepEqual(
    getTranslationCheckpointResumeMetadata(
      version3Checkpoint,
      configFingerprint
    ),
    {
      analysis: "v3 context",
      shouldBackupCheckpoint: false,
      shouldRestartTranslation: false,
    }
  );
  assert.equal(hasMatchingTranslationTask(version2Checkpoint, taskId), true);
  assert.equal(hasMatchingTranslationTask(version3Checkpoint, taskId), true);
  assert.equal(
    hasMatchingTranslationTask(version3Checkpoint, otherTaskId),
    false
  );
});

test("restarts legacy checkpoints whose content configuration cannot be proven", () => {
  const legacyCheckpoint = {
    version: 1 as const,
    format: "srt",
    source: { name: "episode.srt", fingerprint },
    analysis: "Legacy context",
  };

  assert.deepEqual(
    getTranslationCheckpointResumeMetadata(
      legacyCheckpoint,
      "a".repeat(64)
    ),
    {
      analysis: undefined,
      shouldBackupCheckpoint: true,
      shouldRestartTranslation: true,
    }
  );
  assert.deepEqual(
    getTranslationCheckpointResumeMetadata(legacyCheckpoint),
    {
      analysis: "Legacy context",
      shouldBackupCheckpoint: false,
      shouldRestartTranslation: false,
    }
  );
});

test("backs up old-language progress before writing a clean restarted checkpoint", async (context) => {
  const directory = await createCheckpointTestDirectory(context);
  const checkpointPath = path.join(directory, "episode.translation.json");
  const previousConfigFingerprint = "a".repeat(64);
  const latestConfigFingerprint = "b".repeat(64);
  const checkpointDocument = {
    version: 2 as const,
    format: "srt",
    source: { name: "episode.srt", fingerprint },
    translation: { configFingerprint: previousConfigFingerprint },
    subtitle: [
      {
        type: "cue",
        data: {
          start: 0,
          end: 1_000,
          text: "原文",
          translatedText: "Previous English translation",
        },
      },
    ],
    analysis: "Previous configuration analysis",
  };
  await writeFile(
    checkpointPath,
    JSON.stringify(checkpointDocument),
    "utf8"
  );

  const resumeMetadata = getTranslationCheckpointResumeMetadata(
    checkpointDocument,
    latestConfigFingerprint
  );
  assert.equal(resumeMetadata.shouldBackupCheckpoint, true);
  assert.equal(resumeMetadata.shouldRestartTranslation, true);

  const backupPath = await copyTranslationCheckpointBackup(
    checkpointPath,
    taskId
  );
  clearSubtitleCueTranslations(checkpointDocument.subtitle);
  const { analysis: _oldAnalysis, ...checkpointWithoutAnalysis } =
    checkpointDocument;
  const writer = createCheckpointWriter(checkpointPath, () => ({
    ...checkpointWithoutAnalysis,
    translation: { configFingerprint: latestConfigFingerprint },
  }));
  await writer.write();

  const backupDocument = JSON.parse(await readFile(backupPath, "utf8"));
  const restartedDocument = JSON.parse(
    await readFile(checkpointPath, "utf8")
  );
  assert.equal(
    backupDocument.subtitle[0].data.translatedText,
    "Previous English translation"
  );
  assert.equal(
    "translatedText" in restartedDocument.subtitle[0].data,
    false
  );
  assert.equal(restartedDocument.analysis, undefined);
  assert.equal(
    restartedDocument.translation.configFingerprint,
    latestConfigFingerprint
  );
});

test("finds both stable and version 1.8.0 checkpoint names", () => {
  const sourcePath = path.join("/tmp", "episode.srt");
  const checkpointPath = path.join("/tmp", "episode.translation.json");

  assert.deepEqual(
    getTranslationCheckpointCandidates(sourcePath),
    [
      path.join("/tmp", "episode.translation.json"),
      path.join("/tmp", "episode.srt.translation.json"),
    ]
  );
  assert.deepEqual(
    getTranslationCheckpointCandidates(checkpointPath),
    [checkpointPath]
  );
});

test("gives each task for the same subtitle a distinct Windows-safe checkpoint", () => {
  const sourcePath = path.join("subtitles", "movie.srt");
  const firstPath = getTaskTranslationCheckpointPath(sourcePath, taskId);
  const secondPath = getTaskTranslationCheckpointPath(sourcePath, otherTaskId);

  assert.equal(
    firstPath,
    path.join(
      "subtitles",
      "movie.translation.11111111111141118111111111111111.json"
    )
  );
  assert.notEqual(firstPath, secondPath);
  assert.equal(path.basename(firstPath).includes("-"), false);
});

test("discovers only exact task checkpoint names", () => {
  const sourcePath = path.join("subtitles", "movie.srt");
  assert.deepEqual(
    getDiscoveredTaskTranslationCheckpointPaths(sourcePath, [
      "movie.translation.11111111111141118111111111111111.json",
      "movie.translation.22222222222242228222222222222222.json",
      "movie.translation.json",
      "movie.srt.translation.json",
      "movie.translation.11111111111141118111111111111111.json.tmp",
      "movie.translation.11111111111141118111111111111111.json.11111111111141118111111111111111.1.backup.json",
      "another.translation.11111111111141118111111111111111.json",
    ]),
    [
      path.join(
        "subtitles",
        "movie.translation.11111111111141118111111111111111.json"
      ),
      path.join(
        "subtitles",
        "movie.translation.22222222222242228222222222222222.json"
      ),
    ]
  );
});

test("accepts UUID task identities and rejects unsafe path-like values", () => {
  assert.equal(isTranslationTaskId(taskId), true);
  assert.equal(isTranslationTaskId(otherTaskId), true);
  assert.equal(isTranslationTaskId("../unsafe"), false);
  assert.equal(isTranslationTaskId("11111111111141118111111111111111"), false);
  assert.throws(
    () =>
      getTaskTranslationCheckpointPath(
        path.join("subtitles", "movie.srt"),
        "../unsafe"
      ),
    /Invalid translation task ID/
  );
});

test("migrates v2 to v3 only after the new checkpoint is atomically committed", async (context) => {
  const directory = await createCheckpointTestDirectory(context);
  const sourcePath = path.join(directory, "movie.srt");
  const legacyPath = path.join(directory, "movie.translation.json");
  const targetPath = getTaskTranslationCheckpointPath(sourcePath, taskId);
  const subtitle = [
    {
      type: "cue" as const,
      data: {
        start: 0,
        end: 1_000,
        text: "Original",
        translatedText: "Existing translation",
      },
    },
  ];
  const legacyDocument = {
    version: 2 as const,
    format: "srt" as const,
    source: { name: "movie.srt", fingerprint },
    translation: { configFingerprint: "a".repeat(64) },
    subtitle,
  };
  await writeFile(legacyPath, JSON.stringify(legacyDocument), "utf8");
  const writer = createCheckpointWriter(targetPath, () => ({
    version: 3,
    format: "srt",
    source: { name: "movie.srt", fingerprint },
    translation: { configFingerprint: "a".repeat(64) },
    task: { id: taskId },
    subtitle,
  }));

  assert.equal(await readFile(legacyPath, "utf8"), JSON.stringify(legacyDocument));
  await writer.write();
  assert.equal(JSON.parse(await readFile(targetPath, "utf8")).version, 3);
  assert.equal(JSON.parse(await readFile(legacyPath, "utf8")).version, 2);

  const backupPath = await backupTranslationCheckpoint(legacyPath, taskId);
  assert.equal(JSON.parse(await readFile(backupPath, "utf8")).version, 2);
  const ownedBackups = getOwnedTranslationCheckpointBackupPaths(
    directory,
    await readdir(directory),
    [taskId]
  );
  assert.deepEqual(ownedBackups, [backupPath]);

  await removeTranslationCheckpointArtifacts([targetPath, ...ownedBackups]);
  assert.deepEqual(await readdir(directory), []);
});

test("keeps the legacy checkpoint untouched when the v3 commit fails", async (context) => {
  const directory = await createCheckpointTestDirectory(context);
  const legacyPath = path.join(directory, "movie.translation.json");
  const targetPath = getTaskTranslationCheckpointPath(
    path.join(directory, "movie.srt"),
    taskId
  );
  await writeFile(legacyPath, "legacy progress", "utf8");
  const writer = createCheckpointWriter(
    targetPath,
    () => ({ version: 3 }),
    async () => {
      throw createFileSystemError("ENOSPC");
    }
  );

  await assert.rejects(writer.write(), /Simulated file system error: ENOSPC/);
  assert.equal(await readFile(legacyPath, "utf8"), "legacy progress");
  assert.deepEqual(await readdir(directory), ["movie.translation.json"]);
});

test("same-path migration keeps the active checkpoint when the replacement fails", async (context) => {
  const directory = await createCheckpointTestDirectory(context);
  const checkpointPath = path.join(directory, "movie.translation.json");
  await writeFile(checkpointPath, "last valid progress", "utf8");
  const backupPath = await copyTranslationCheckpointBackup(
    checkpointPath,
    taskId
  );
  const writer = createCheckpointWriter(
    checkpointPath,
    () => ({ version: 3 }),
    async () => {
      throw createFileSystemError("ENOSPC");
    }
  );

  await assert.rejects(writer.write(), /Simulated file system error: ENOSPC/);
  assert.equal(await readFile(checkpointPath, "utf8"), "last valid progress");
  assert.equal(await readFile(backupPath, "utf8"), "last valid progress");
});

test("successful cleanup removes only backups owned by that task", async (context) => {
  const directory = await createCheckpointTestDirectory(context);
  const firstCheckpoint = path.join(directory, "movie.translation.json");
  const secondCheckpoint = path.join(directory, "movie.srt.translation.json");
  await writeFile(firstCheckpoint, "first", "utf8");
  await writeFile(secondCheckpoint, "second", "utf8");
  const firstBackup = await backupTranslationCheckpoint(firstCheckpoint, taskId);
  const secondBackup = await backupTranslationCheckpoint(
    secondCheckpoint,
    otherTaskId
  );

  const firstOwnedBackups = getOwnedTranslationCheckpointBackupPaths(
    directory,
    await readdir(directory),
    [taskId]
  );
  assert.deepEqual(firstOwnedBackups, [firstBackup]);
  await removeTranslationCheckpointArtifacts(firstOwnedBackups);

  assert.deepEqual(await readdir(directory), [path.basename(secondBackup)]);
  assert.equal(await readFile(secondBackup, "utf8"), "second");
});

test("retries transient Windows rename failures and commits atomically", async (context) => {
  const directory = await createCheckpointTestDirectory(context);
  const checkpointPath = path.join(directory, "episode.translation.json");
  await writeFile(checkpointPath, "old checkpoint", "utf8");

  const waits: number[] = [];
  const temporaryPaths: string[] = [];
  let renameAttempts = 0;

  await writeTranslationCheckpointAtomically(checkpointPath, "new checkpoint", {
    platform: "win32",
    retryDelaysMs: [1, 2, 3, 4],
    renameFile: async (temporaryPath, destinationPath) => {
      renameAttempts += 1;
      temporaryPaths.push(temporaryPath);
      if (renameAttempts < 3) throw createFileSystemError("EPERM");
      await rename(temporaryPath, destinationPath);
    },
    wait: async (delayMs) => {
      waits.push(delayMs);
    },
  });

  assert.equal(renameAttempts, 3);
  assert.deepEqual(waits, [1, 2]);
  assert.ok(
    temporaryPaths.every(
      (temporaryPath) => path.dirname(temporaryPath) === directory
    )
  );
  assert.equal(await readFile(checkpointPath, "utf8"), "new checkpoint");
  assert.deepEqual(await readdir(directory), ["episode.translation.json"]);
});

test("preserves the last valid checkpoint when Windows retries are exhausted", async (context) => {
  const directory = await createCheckpointTestDirectory(context);
  const checkpointPath = path.join(directory, "episode.translation.json");
  await writeFile(checkpointPath, "last valid checkpoint", "utf8");

  const waits: number[] = [];
  let renameAttempts = 0;
  await assert.rejects(
    writeTranslationCheckpointAtomically(checkpointPath, "new checkpoint", {
      platform: "win32",
      retryDelaysMs: [1, 2, 3, 4],
      renameFile: async () => {
        renameAttempts += 1;
        throw createFileSystemError("EBUSY");
      },
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    }),
    (error: unknown) =>
      (error as NodeJS.ErrnoException | undefined)?.code === "EBUSY"
  );

  assert.equal(renameAttempts, 5);
  assert.deepEqual(waits, [1, 2, 3, 4]);
  assert.equal(
    await readFile(checkpointPath, "utf8"),
    "last valid checkpoint"
  );
  assert.deepEqual(await readdir(directory), ["episode.translation.json"]);
});

test("does not retry non-transient or non-Windows rename errors", async (context) => {
  const directory = await createCheckpointTestDirectory(context);

  for (const [platform, errorCode] of [
    ["win32", "ENOSPC"],
    ["linux", "EPERM"],
  ] as const) {
    const checkpointPath = path.join(
      directory,
      `${platform}.translation.json`
    );
    await writeFile(checkpointPath, `${platform} checkpoint`, "utf8");
    let renameAttempts = 0;
    let waitCount = 0;

    await assert.rejects(
      writeTranslationCheckpointAtomically(checkpointPath, "new checkpoint", {
        platform,
        retryDelaysMs: [1, 2, 3, 4],
        renameFile: async () => {
          renameAttempts += 1;
          throw createFileSystemError(errorCode);
        },
        wait: async () => {
          waitCount += 1;
        },
      }),
      (error: unknown) =>
        (error as NodeJS.ErrnoException | undefined)?.code === errorCode
    );

    assert.equal(renameAttempts, 1);
    assert.equal(waitCount, 0);
    assert.equal(
      await readFile(checkpointPath, "utf8"),
      `${platform} checkpoint`
    );
  }
});

test("serial checkpoint writer recovers after one failed write", async () => {
  let documentVersion = 1;
  let writeAttempts = 0;
  const writtenVersions: number[] = [];
  const writer = createCheckpointWriter(
    "episode.translation.json",
    () => ({ version: documentVersion }),
    async (_checkpointPath, content) => {
      writeAttempts += 1;
      writtenVersions.push(JSON.parse(content).version);
      if (writeAttempts === 1) throw createFileSystemError("EPERM");
    }
  );

  await assert.rejects(writer.write(), /Simulated file system error: EPERM/);
  documentVersion = 2;
  await writer.write();
  await writer.wait();

  assert.equal(writeAttempts, 2);
  assert.deepEqual(writtenVersions, [1, 2]);
});
