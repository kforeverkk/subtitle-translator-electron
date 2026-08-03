import { test, expect, _electron as electron } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

test.describe.configure({ mode: "serial" });

const sourceAppVersion = (
  JSON.parse(
    readFileSync(path.resolve("package.json"), "utf8")
  ) as { version: string }
).version;
const isolatedE2eUserDataDirectory = mkdtempSync(
  path.join(tmpdir(), "subtitle-translator-e2e-profile-")
);
process.env.SUBTITLE_TRANSLATOR_E2E_USER_DATA =
  isolatedE2eUserDataDirectory;

test.afterAll(() => {
  delete process.env.SUBTITLE_TRANSLATOR_E2E_USER_DATA;
  rmSync(isolatedE2eUserDataDirectory, { recursive: true, force: true });
});

function createTestTranslationConfigFingerprint(config: {
  apiHost: string;
  model: string;
  prompt: string;
  lang: string;
  additional: string;
  temperature: number;
  contextSize: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        2,
        config.apiHost,
        config.model,
        config.prompt,
        config.lang,
        config.additional,
        config.temperature,
        config.contextSize,
      ])
    )
    .digest("hex");
}

async function startMockOpenAiServer(options: {
  streamDelayMs?: number | ((requestBodyText: string) => number);
  getStreamElements?: (requestBodyText: string) => string[];
  onRequest?: (request: {
    startedAt: number;
    authorization?: string;
    bodyText: string;
  }) => void;
} = {}): Promise<{
  apiHost: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/v1/models") {
        request.resume();
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
        return;
      }

      if (request.url === "/v1/chat/completions") {
        const startedAt = Date.now();
        const requestChunks: Buffer[] = [];
        for await (const chunk of request) {
          requestChunks.push(Buffer.from(chunk));
        }
        const requestBody = JSON.parse(
          Buffer.concat(requestChunks).toString("utf8")
        ) as { stream?: boolean };
        const requestBodyText = JSON.stringify(requestBody);
        options.onRequest?.({
          startedAt,
          authorization:
            typeof request.headers.authorization === "string"
              ? request.headers.authorization
              : undefined,
          bodyText: requestBodyText,
        });
        const created = Math.floor(Date.now() / 1_000);
        if (requestBody.stream) {
          const streamDelayMs =
            typeof options.streamDelayMs === "function"
              ? options.streamDelayMs(requestBodyText)
              : options.streamDelayMs;
          if (streamDelayMs) {
            await wait(streamDelayMs);
          }
          response.setHeader("Content-Type", "text/event-stream");
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-stream-test",
              object: "chat.completion.chunk",
              created,
              model: "test-model",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: JSON.stringify({
                      elements:
                        options.getStreamElements?.(requestBodyText) ??
                        ["Fresh translation"],
                    }),
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`
          );
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-stream-test",
              object: "chat.completion.chunk",
              created,
              model: "test-model",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            })}\n\n`
          );
          response.end("data: [DONE]\n\n");
          return;
        }

        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created,
            model: "test-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({ language: "Chinese" }),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          })
        );
        return;
      }

      request.resume();
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: "Not found" }));
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock OpenAI server did not bind to a TCP port");
  }
  return {
    apiHost: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

test("homepage has title and links to intro page", async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const page = await app.firstWindow();
    const runtime = await app.evaluate(({ app: electronApp }) => ({
      appPath: electronApp.getAppPath(),
      userDataPath: electronApp.getPath("userData"),
      version: electronApp.getVersion(),
    }));
    expect(path.resolve(runtime.appPath)).toBe(path.resolve("."));
    expect(path.resolve(runtime.userDataPath)).toBe(
      path.resolve(isolatedE2eUserDataDirectory)
    );
    expect(runtime.version).toBe(sourceAppVersion);
    expect(await page.title()).toBe("Subtitle translator");
    await page.screenshot({ path: "e2e/screenshots/example.png" });
  } finally {
    await app.close();
  }
});

test("packaged Windows GUI uses the current isolated build", async ({}, testInfo) => {
  const packagedExecutable =
    process.env.SUBTITLE_TRANSLATOR_PACKAGED_EXE?.trim();
  test.skip(
    process.platform !== "win32" || !packagedExecutable,
    "Set SUBTITLE_TRANSLATOR_PACKAGED_EXE to validate a packaged Windows build."
  );

  const expectedExecutablePath = path.resolve(packagedExecutable!);
  const app = await electron.launch({
    executablePath: expectedExecutablePath,
    args: ["--no-sandbox"],
  });
  try {
    const page = await app.firstWindow();
    const runtime = await app.evaluate(({ app: electronApp }) => ({
      executablePath: electronApp.getPath("exe"),
      userDataPath: electronApp.getPath("userData"),
      version: electronApp.getVersion(),
    }));

    expect(path.resolve(runtime.executablePath)).toBe(expectedExecutablePath);
    expect(path.resolve(runtime.userDataPath)).toBe(
      path.resolve(isolatedE2eUserDataDirectory)
    );
    expect(runtime.version).toBe(sourceAppVersion);
    expect(await page.title()).toBe("Subtitle translator");

    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("language", JSON.stringify("en-US"));
    });
    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(
      page.getByRole("heading", { name: "API connection" })
    ).toBeVisible();
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "简体中文" }).click();
    await expect(page.getByRole("heading", { name: "API 连接" })).toBeVisible();
    await expect(page.getByRole("combobox").first()).toHaveText("简体中文");
    await page.screenshot({
      path: testInfo.outputPath("packaged-windows-settings-zh-CN.png"),
      fullPage: true,
    });
  } finally {
    await app.close();
  }
});

test("about shows project links and build metadata", async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const page = await app.firstWindow();

    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("language", JSON.stringify("en-US"));
    });
    await page.reload();
    await page.evaluate(() => {
      window.location.hash = "#/about";
    });

    await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
    await expect(page.getByText(/^\d+\.\d+\.\d+$/)).toBeVisible();
    await expect(page.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/kforeverkk/subtitle-translator-electron"
    );
    await expect(
      page.getByRole("link", { name: "Report an Issue" })
    ).toHaveAttribute(
      "href",
      "https://github.com/kforeverkk/subtitle-translator-electron/issues"
    );
    await expect(
      page.getByRole("link", { name: "Buy Me a Coffee" })
    ).toHaveAttribute("href", "https://www.buymeacoffee.com/gnehs");
    await expect(
      page.getByRole("link").filter({ hasText: /^[0-9a-f]{7}$/i })
    ).toHaveAttribute(
      "href",
      /https:\/\/github\.com\/kforeverkk\/subtitle-translator-electron\/commit\/[0-9a-f]{7}$/i
    );
  } finally {
    await app.close();
  }
});

test("about follows the main window and wake events recreate the main window", async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const mainPage = await app.firstWindow();
    await mainPage.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("language", JSON.stringify("en-US"));
    });
    await mainPage.reload();
    await expect(
      mainPage.getByRole("button", { name: "Settings" })
    ).toBeVisible();

    await app.evaluate(({ BrowserWindow }) => {
      const auxiliaryWindow = new BrowserWindow({ show: false });
      const lifecycleGlobal = globalThis as typeof globalThis & {
        __subtitleTranslatorLifecycleAuxWindowId?: number;
      };
      lifecycleGlobal.__subtitleTranslatorLifecycleAuxWindowId =
        auxiliaryWindow.id;
    });

    const aboutPagePromise = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (!menu) throw new Error("Application menu not found");

      const aboutItem =
        process.platform === "darwin"
          ? menu.items[0]?.submenu?.items[0]
          : menu.items.at(-1)?.submenu?.items[0];
      if (!aboutItem?.click) throw new Error("About menu item not found");

      aboutItem.click(
        aboutItem,
        BrowserWindow.getFocusedWindow() ?? undefined,
        {} as Electron.KeyboardEvent
      );
    });
    const aboutPage = await aboutPagePromise;
    await expect(
      aboutPage.getByRole("heading", { name: "About" })
    ).toBeVisible();

    const readWindowState = () =>
      app.evaluate(({ BrowserWindow }) => {
        const lifecycleGlobal = globalThis as typeof globalThis & {
          __subtitleTranslatorLifecycleAuxWindowId?: number;
        };
        const auxiliaryId =
          lifecycleGlobal.__subtitleTranslatorLifecycleAuxWindowId;
        const windows = BrowserWindow.getAllWindows().filter(
          (window) =>
            !window.isDestroyed() && !window.webContents.isDestroyed()
        );
        const aboutWindows = windows.filter((window) =>
          window.webContents.getURL().includes("#/about")
        );
        const mainWindows = windows.filter(
          (window) =>
            window.id !== auxiliaryId &&
            !window.webContents.getURL().includes("#/about")
        );

        return {
          auxiliaryAlive: windows.some((window) => window.id === auxiliaryId),
          mainCount: mainWindows.length,
          aboutCount: aboutWindows.length,
          aboutParentMatchesMain:
            aboutWindows[0]?.getParentWindow()?.id === mainWindows[0]?.id,
        };
      });
    const closeMainWindow = () =>
      app.evaluate(({ BrowserWindow }) => {
        const lifecycleGlobal = globalThis as typeof globalThis & {
          __subtitleTranslatorLifecycleAuxWindowId?: number;
        };
        const auxiliaryId =
          lifecycleGlobal.__subtitleTranslatorLifecycleAuxWindowId;
        const mainWindow = BrowserWindow.getAllWindows().find(
          (window) =>
            !window.isDestroyed() &&
            !window.webContents.isDestroyed() &&
            window.id !== auxiliaryId &&
            !window.webContents.getURL().includes("#/about")
        );
        if (!mainWindow) throw new Error("Main window not found");
        mainWindow.close();
      });

    await expect.poll(readWindowState).toMatchObject({
      auxiliaryAlive: true,
      mainCount: 1,
      aboutCount: 1,
      aboutParentMatchesMain: true,
    });

    await closeMainWindow();
    await expect.poll(readWindowState).toMatchObject({
      auxiliaryAlive: true,
      mainCount: 0,
      aboutCount: 0,
    });

    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit(
        "second-instance",
        {} as Electron.Event,
        [],
        "",
        {}
      );
    });
    await expect.poll(readWindowState).toMatchObject({
      auxiliaryAlive: true,
      mainCount: 1,
      aboutCount: 0,
    });

    await closeMainWindow();
    await expect.poll(readWindowState).toMatchObject({
      auxiliaryAlive: true,
      mainCount: 0,
      aboutCount: 0,
    });

    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit("activate", {} as Electron.Event, false);
    });
    await expect.poll(readWindowState).toMatchObject({
      auxiliaryAlive: true,
      mainCount: 1,
      aboutCount: 0,
    });

    await app.evaluate(({ BrowserWindow }) => {
      const lifecycleGlobal = globalThis as typeof globalThis & {
        __subtitleTranslatorLifecycleAuxWindowId?: number;
      };
      const auxiliaryId =
        lifecycleGlobal.__subtitleTranslatorLifecycleAuxWindowId;
      if (auxiliaryId !== undefined) {
        const auxiliaryWindow = BrowserWindow.fromId(auxiliaryId);
        if (auxiliaryWindow && !auxiliaryWindow.isDestroyed()) {
          auxiliaryWindow.close();
        }
      }
      delete lifecycleGlobal.__subtitleTranslatorLifecycleAuxWindowId;
    });
  } finally {
    await app.close();
  }
});

test("settings shows the API connection test control", async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const page = await app.firstWindow();

    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();

    await expect(page.getByRole("heading", { name: "API connection" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Test connection" })
    ).toBeDisabled();
  } finally {
    await app.close();
  }
});

test("checkpoint save failures show a non-fatal recovery warning", async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("language", JSON.stringify("en-US"));
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Settings" })
    ).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );

    await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (window) => !window.isDestroyed() && !window.webContents.isDestroyed()
      );
      if (!mainWindow) throw new Error("Main window not found");

      mainWindow.webContents.send("checkpoint-save-warning", {
        taskId: "11111111-1111-4111-8111-111111111111",
        filePath: "C:\\media\\episode.srt",
      });
    });

    await expect(
      page.getByText(
        "Translation is continuing, but recovery progress could not be saved temporarily for episode.srt. If the app closes before a later save succeeds, it will resume from the last valid checkpoint."
      )
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("concurrent batches share one RPM budget for the same API account", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-shared-rpm-")
  );
  const englishSourcePath = path.join(temporaryDirectory, "english-source.srt");
  const frenchSourcePath = path.join(temporaryDirectory, "french-source.srt");
  const sourceText = "1\n00:00:00,000 --> 00:00:01,000\n你好\n";
  writeFileSync(englishSourcePath, sourceText, "utf8");
  writeFileSync(frenchSourcePath, sourceText, "utf8");
  const requestStarts: number[] = [];
  const mockServer = await startMockOpenAiServer({
    getStreamElements: (requestBodyText) =>
      /French/i.test(requestBodyText) ? ["Bonjour"] : ["Hello"],
    onRequest: ({ startedAt }) => requestStarts.push(startedAt),
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    await page.evaluate(
      async ({ apiHost, englishSourcePath, frenchSourcePath }) => {
        const createParams = (lang: string) => ({
          apiKeys: ["test-key"],
          apiHost,
          model: "test-model",
          prompt: "Translate every cue to {{lang}}. {{additional}}",
          lang,
          additional: "",
          temperature: 1,
          outputFormat: "srt-translation" as const,
          assFonts: { translationFont: "", originalFont: "" },
          concurrency: 1 as const,
          delay: 120,
          requestsPerMinute: 1_000,
          contextSize: 5,
        });

        const englishBatch = window.electronAPI.translateBatch({
          files: [
            {
              taskId: "77777777-7777-4777-8777-777777777777",
              path: englishSourcePath,
              name: "english-source.srt",
            },
          ],
          params: createParams("English"),
        });
        const frenchBatch = window.electronAPI.translateBatch({
          files: [
            {
              taskId: "88888888-8888-4888-8888-888888888888",
              path: frenchSourcePath,
              name: "french-source.srt",
            },
          ],
          params: createParams("French"),
        });

        await Promise.all([englishBatch, frenchBatch]);
      },
      {
        apiHost: mockServer.apiHost,
        englishSourcePath,
        frenchSourcePath,
      }
    );

    expect(requestStarts).toHaveLength(4);
    const sortedRequestStarts = [...requestStarts].sort(
      (left, right) => left - right
    );
    for (let index = 1; index < sortedRequestStarts.length; index++) {
      expect(
        sortedRequestStarts[index] - sortedRequestStarts[index - 1]
      ).toBeGreaterThanOrEqual(90);
    }
    expect(
      readFileSync(path.join(temporaryDirectory, "english-source.en.srt"), "utf8")
    ).toContain("Hello");
    expect(
      readFileSync(path.join(temporaryDirectory, "french-source.fr.srt"), "utf8")
    ).toContain("Bonjour");
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("a single zero-delay batch keeps its API count and throughput", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-single-rpm-")
  );
  const sourcePath = path.join(temporaryDirectory, "single-source.srt");
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  const requestStarts: number[] = [];
  const mockServer = await startMockOpenAiServer({
    getStreamElements: () => ["Hello"],
    onRequest: ({ startedAt }) => requestStarts.push(startedAt),
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    await page.evaluate(
      async ({ apiHost, sourcePath }) => {
        await window.electronAPI.translateBatch({
          files: [
            {
              taskId: "99999999-9999-4999-8999-999999999999",
              path: sourcePath,
              name: "single-source.srt",
            },
          ],
          params: {
            apiKeys: ["test-key"],
            apiHost,
            model: "test-model",
            prompt: "Translate every cue to {{lang}}. {{additional}}",
            lang: "English",
            additional: "",
            temperature: 1,
            outputFormat: "srt-translation",
            assFonts: { translationFont: "", originalFont: "" },
            concurrency: 1,
            delay: 0,
            requestsPerMinute: 1_000,
            contextSize: 5,
          },
        });
      },
      { apiHost: mockServer.apiHost, sourcePath }
    );

    expect(requestStarts).toHaveLength(2);
    const sortedRequestStarts = [...requestStarts].sort(
      (left, right) => left - right
    );
    expect(sortedRequestStarts[1] - sortedRequestStarts[0]).toBeLessThan(500);
    expect(
      readFileSync(path.join(temporaryDirectory, "single-source.en.srt"), "utf8")
    ).toContain("Hello");
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("v1 migration and same-source v2/v3 resumes remain independent", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-multilang-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  const sourceInfo = statSync(sourcePath);
  const sourceFingerprint = {
    size: sourceInfo.size,
    mtimeMs: sourceInfo.mtimeMs,
  };
  const prompt = "Translate each cue to {{lang}}. {{additional}}";
  const model = "test-model";
  const mockServer = await startMockOpenAiServer();
  const legacyV1Path = path.join(temporaryDirectory, "legacy-v1.json");
  writeFileSync(
    legacyV1Path,
    JSON.stringify({
      version: 1,
      format: "srt",
      source: { name: "legacy.srt" },
      subtitle: [
        {
          type: "cue",
          data: {
            start: 0,
            end: 1_000,
            text: "旧版原文",
            translatedText: "Legacy translation",
          },
        },
      ],
    }),
    "utf8"
  );
  const legacySourcePath = path.join(temporaryDirectory, "legacy-source.srt");
  writeFileSync(
    legacySourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n当前原文\n",
    "utf8"
  );
  writeFileSync(
    path.join(temporaryDirectory, "legacy-source.translation.json"),
    JSON.stringify({
      version: 1,
      format: "srt",
      source: { name: "legacy-source.srt" },
      subtitle: [
        {
          type: "cue",
          data: {
            start: 0,
            end: 1_000,
            text: "已经过时的原文",
            translatedText: "Stale translation",
          },
        },
      ],
    }),
    "utf8"
  );
  const storedTaskIds = {
    English: "11111111-1111-4111-8111-111111111111",
    French: "22222222-2222-4222-8222-222222222222",
  } as const;
  const resumedTaskIds = {
    English: "33333333-3333-4333-8333-333333333333",
    French: "44444444-4444-4444-8444-444444444444",
  } as const;
  for (const [lang, translatedText] of [
    ["English", "Hello"],
    ["French", "Bonjour"],
  ] as const) {
    const storedTaskId = storedTaskIds[lang];
    const compactTaskId = storedTaskId.replaceAll("-", "");
    const configFingerprint = createTestTranslationConfigFingerprint({
      apiHost: mockServer.apiHost,
      model,
      prompt,
      lang,
      additional: "",
      temperature: 1,
      contextSize: 5,
    });
    writeFileSync(
      path.join(
        temporaryDirectory,
        lang === "English"
          ? "movie.translation.json"
          : `movie.translation.${compactTaskId}.json`
      ),
      JSON.stringify({
        version: lang === "English" ? 2 : 3,
        format: "srt",
        source: { name: "movie.srt", fingerprint: sourceFingerprint },
        translation: { configFingerprint },
        ...(lang === "French" ? { task: { id: storedTaskId } } : {}),
        subtitle: [
          {
            type: "cue",
            data: {
              start: 0,
              end: 1_000,
              text: "你好",
              translatedText,
            },
          },
        ],
      }),
      "utf8"
    );
  }

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const legacyV1Preview = await page.evaluate(
      (filePath) =>
        window.electronAPI.getSubtitlePreview({
          taskId: "55555555-5555-4555-8555-555555555555",
          filePath,
        }),
      legacyV1Path
    );
    expect(legacyV1Preview.cues).toEqual([
      expect.objectContaining({
        text: "旧版原文",
        translatedText: "Legacy translation",
      }),
    ]);
    await page.evaluate(
      async ({ sourcePath, legacySourcePath, apiHost, prompt, model, resumedTaskIds }) => {
        const createParams = (lang: string) => ({
          apiKeys: ["test-key"],
          apiHost,
          model,
          prompt,
          lang,
          additional: "",
          temperature: 1,
          outputFormat: "srt-translation" as const,
          assFonts: { translationFont: "", originalFont: "" },
          concurrency: 1 as const,
          delay: 0,
          requestsPerMinute: 1_000,
          contextSize: 5,
        });
        await Promise.all([
          window.electronAPI.translateBatch({
            files: [
              {
                taskId: resumedTaskIds.English,
                path: sourcePath,
                name: "movie.srt",
              },
            ],
            params: createParams("English"),
          }),
          window.electronAPI.translateBatch({
            files: [
              {
                taskId: resumedTaskIds.French,
                path: sourcePath,
                name: "movie.srt",
              },
            ],
            params: createParams("French"),
          }),
          window.electronAPI.translateBatch({
            files: [
              {
                taskId: "66666666-6666-4666-8666-666666666666",
                path: legacySourcePath,
                name: "legacy-source.srt",
              },
            ],
            params: createParams("English"),
          }),
        ]);
      },
      {
        sourcePath,
        legacySourcePath,
        apiHost: mockServer.apiHost,
        prompt,
        model,
        resumedTaskIds,
      }
    );

    const englishOutput = readFileSync(
      path.join(temporaryDirectory, "movie.en.srt"),
      "utf8"
    );
    const frenchOutput = readFileSync(
      path.join(temporaryDirectory, "movie.fr.srt"),
      "utf8"
    );
    expect(englishOutput).toContain("Hello");
    expect(englishOutput).not.toContain("Bonjour");
    expect(frenchOutput).toContain("Bonjour");
    expect(frenchOutput).not.toContain("Hello");
    const migratedV1Output = readFileSync(
      path.join(temporaryDirectory, "legacy-source.en.srt"),
      "utf8"
    );
    expect(migratedV1Output).toContain("Fresh translation");
    expect(migratedV1Output).not.toContain("Stale translation");
    expect(migratedV1Output).not.toContain("已经过时的原文");
    expect(
      readdirSync(temporaryDirectory).filter(
        (entry) => entry.includes(".translation.") || entry.endsWith(".backup.json")
      )
    ).toEqual([]);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the real task dialog keeps same-source language jobs independent", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-gui-multilang-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  const mockServer = await startMockOpenAiServer({
    streamDelayMs: 800,
    getStreamElements: (requestBodyText) =>
      /French/i.test(requestBodyText) ? ["Bonjour"] : ["Hello"],
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    await page.evaluate(
      ({ apiHost }) => {
        localStorage.clear();
        localStorage.setItem("language", JSON.stringify("en-US"));
        localStorage.setItem("api_keys", JSON.stringify(["test-key"]));
        localStorage.setItem("api_host", JSON.stringify(apiHost));
        localStorage.setItem("model", JSON.stringify("test-model"));
        localStorage.setItem("prompt", JSON.stringify(
          "Translate every cue to {{lang}}. {{additional}}"
        ));
        localStorage.setItem("translate_lang", JSON.stringify("English"));
        localStorage.setItem("delay", JSON.stringify(0));
        localStorage.setItem("requests_per_minute", JSON.stringify(1000));
        localStorage.setItem("translation_concurrency", JSON.stringify(1));
        localStorage.setItem(
          "subtitle_output_format",
          JSON.stringify("srt-translation")
        );
      },
      { apiHost: mockServer.apiHost }
    );
    await page.reload();

    const addTask = async (targetLanguage: string) => {
      await page.locator('input[type="file"]').setInputFiles(sourcePath);
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.locator("#task-language").fill(targetLanguage);
      await dialog.getByRole("button", { name: "Add task" }).click();
    };

    await addTask("English");
    await addTask("French");

    const taskRows = page.getByRole("row").filter({ hasText: "movie.srt" });
    await expect(taskRows).toHaveCount(2);
    await expect(taskRows.getByText("Completed", { exact: true })).toHaveCount(2, {
      timeout: 10_000,
    });

    const englishOutput = readFileSync(
      path.join(temporaryDirectory, "movie.en.srt"),
      "utf8"
    );
    const frenchOutput = readFileSync(
      path.join(temporaryDirectory, "movie.fr.srt"),
      "utf8"
    );
    expect(englishOutput).toContain("Hello");
    expect(englishOutput).not.toContain("Bonjour");
    expect(frenchOutput).toContain("Bonjour");
    expect(frenchOutput).not.toContain("Hello");
    expect(
      readdirSync(temporaryDirectory).filter(
        (entry) =>
          entry.includes(".translation.") || entry.endsWith(".backup.json")
      )
    ).toEqual([]);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the real GUI clears stale translations before bilingual restart", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-gui-restart-")
  );
  const legacyCheckpointPath = path.join(
    temporaryDirectory,
    "movie.translation.json"
  );
  writeFileSync(
    legacyCheckpointPath,
    JSON.stringify({
      version: 2,
      format: "srt",
      source: { name: "movie.srt" },
      translation: { configFingerprint: "0".repeat(64) },
      subtitle: Array.from({ length: 21 }, (_, index) => ({
          type: "cue",
          data: {
            start: index * 1_000,
            end: (index + 1) * 1_000,
            text: `当前原文 ${index + 1}`,
            translatedText: `Old translation ${index + 1}`,
          },
        })),
    }),
    "utf8"
  );
  const mockServer = await startMockOpenAiServer({
    streamDelayMs: (requestBodyText) =>
      /exactly 1 translated string/i.test(requestBodyText) ? 3_000 : 500,
    getStreamElements: (requestBodyText) => {
      const count = Number(
        requestBodyText.match(/exactly (\d+) translated strings/i)?.[1] ?? 1
      );
      if (count === 1 && requestBodyText.includes("当前原文 21")) {
        return ["New final 21"];
      }
      return Array.from(
        { length: count },
        (_, index) => `New translation ${index + 1}`
      );
    },
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    await page.evaluate(
      ({ apiHost }) => {
        localStorage.clear();
        localStorage.setItem("language", JSON.stringify("en-US"));
        localStorage.setItem("api_keys", JSON.stringify(["test-key"]));
        localStorage.setItem("api_host", JSON.stringify(apiHost));
        localStorage.setItem("model", JSON.stringify("test-model"));
        localStorage.setItem("prompt", JSON.stringify(
          "Translate every cue to {{lang}}. {{additional}}"
        ));
        localStorage.setItem("translate_lang", JSON.stringify("English"));
        localStorage.setItem("delay", JSON.stringify(0));
        localStorage.setItem("requests_per_minute", JSON.stringify(1000));
        localStorage.setItem("translation_concurrency", JSON.stringify(1));
        localStorage.setItem(
          "subtitle_output_format",
          JSON.stringify("srt-bilingual")
        );
      },
      { apiHost: mockServer.apiHost }
    );
    await page.reload();

    await page
      .locator('input[type="file"]')
      .setInputFiles(legacyCheckpointPath);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Add task" }).click();

    await expect
      .poll(
        () => {
          const outputName = readdirSync(temporaryDirectory).find((entry) =>
            entry.endsWith(".srt")
          );
          return outputName
            ? (() => {
                const content = readFileSync(
                  path.join(temporaryDirectory, outputName),
                  "utf8"
                );
                return content.includes("当前原文 21") &&
                  !content.includes("New final 21")
                  ? content
                  : "";
              })()
            : "";
        },
        { timeout: 2_000 }
      )
      .toContain("当前原文 21");
    const outputName = readdirSync(temporaryDirectory).find((entry) =>
      entry.endsWith(".srt")
    );
    expect(outputName).toBe("movie.en-zh.srt");
    const outputPath = path.join(temporaryDirectory, outputName!);
    const pendingOutput = readFileSync(outputPath, "utf8");
    expect(pendingOutput).not.toContain("Old translation");
    expect(pendingOutput.match(/当前原文 21/g)).toHaveLength(1);
    expect(pendingOutput).not.toContain("New final 21");

    const taskRow = page
      .getByRole("row")
      .filter({ hasText: "movie.translation.json" });
    await expect(taskRow.getByText("Completed", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    const completedOutput = readFileSync(outputPath, "utf8");
    expect(completedOutput).toContain("New translation 1");
    expect(completedOutput).toContain("New final 21");
    expect(completedOutput).toContain("当前原文 21");
    expect(completedOutput).not.toContain("Old translation");
    expect(completedOutput.match(/当前原文 21/g)).toHaveLength(1);
    expect(
      readdirSync(temporaryDirectory).filter(
        (entry) =>
          entry.includes(".translation.") || entry.endsWith(".backup.json")
      )
    ).toEqual([]);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("language changes update the native menu immediately and survive reload", async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const page = await app.firstWindow();

    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("language", JSON.stringify("zh-TW"));
    });
    await page.reload();
    await page.getByRole("button", { name: "設定" }).click();

    const readNativeMenuLabels = () =>
      app.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu();
        if (!menu) throw new Error("Application menu not found");

        const localizedMenu =
          process.platform === "darwin" ? menu.items[0] : menu.items.at(-1);
        return {
          help:
            process.platform === "darwin"
              ? null
              : localizedMenu?.label ?? null,
          about: localizedMenu?.submenu?.items[0]?.label ?? null,
        };
      });
    const expectNativeMenuLabels = async (help: string, about: string) => {
      await expect.poll(readNativeMenuLabels).toEqual({
        help: process.platform === "darwin" ? null : help,
        about,
      });
    };

    await expect(page.getByRole("heading", { name: "API 連線" })).toBeVisible();
    await expectNativeMenuLabels("說明", "關於 Subtitle Translator");

    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "English" }).click();
    await expect(
      page.getByRole("heading", { name: "API connection" })
    ).toBeVisible();
    await expectNativeMenuLabels("Help", "About Subtitle Translator");

    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "简体中文" }).click();
    await expect(page.getByRole("heading", { name: "API 连接" })).toBeVisible();
    await expectNativeMenuLabels("帮助", "关于 Subtitle Translator");

    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "繁體中文" }).click();
    await expect(page.getByRole("heading", { name: "API 連線" })).toBeVisible();
    await expectNativeMenuLabels("說明", "關於 Subtitle Translator");

    await page.reload();

    await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "API 連線" })).toBeVisible();
    await expect(page.getByRole("combobox").first()).toHaveText("繁體中文");
    await page.getByRole("button", { name: "關閉" }).click();
    await expect(page.getByRole("button", { name: "新增任務" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a rejected batch IPC request marks every task as failed", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-invalid-batch-")
  );
  const subtitlePaths = ["invalid-one.srt", "invalid-two.srt"].map(
    (fileName) => path.join(temporaryDirectory, fileName)
  );
  for (const subtitlePath of subtitlePaths) {
    writeFileSync(
      subtitlePath,
      "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
      "utf8"
    );
  }

  try {
    const app = await electron.launch({ args: [".", "--no-sandbox"] });
    try {
      const page = await app.firstWindow();
      await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem("language", JSON.stringify("en-US"));
        localStorage.setItem("api_keys", JSON.stringify(["test-key"]));
        localStorage.setItem(
          "api_host",
          JSON.stringify("http://example.com/v1")
        );
        localStorage.setItem("model", JSON.stringify("test-model"));
        localStorage.setItem("translate_lang", JSON.stringify("English"));
      });
      await page.reload();

      await page.locator('input[type="file"]').setInputFiles(subtitlePaths);
      const taskDialog = page.getByRole("dialog");
      await expect(taskDialog).toBeVisible();
      await taskDialog.getByRole("button", { name: "Add task" }).click();

      for (const subtitlePath of subtitlePaths) {
        const fileName = path.basename(subtitlePath);
        const taskRow = page.getByRole("row").filter({ hasText: fileName });
        await expect(taskRow.getByText("Failed", { exact: true })).toBeVisible();
        await expect(
          taskRow.getByText("Pending", { exact: true })
        ).not.toBeVisible();
        await expect(
          taskRow.getByRole("button", {
            name: `Retry translation for ${fileName}`,
          })
        ).toBeVisible();
      }

      await page
        .getByRole("button", {
          name: "View translation details for invalid-one.srt",
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "Error details" })
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(page.locator("pre")).toContainText(
        "API host must use HTTPS unless it is a local server"
      );
      await page
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .click();

      // Re-adding the same source creates a second logical task instead of
      // overwriting the first row's progress/error state.
      await page
        .locator('input[type="file"]')
        .setInputFiles(subtitlePaths[0]);
      const duplicateTaskDialog = page.getByRole("dialog");
      await expect(duplicateTaskDialog).toBeVisible();
      await duplicateTaskDialog
        .getByRole("button", { name: "Add task" })
        .click();
      const duplicateSourceRows = page
        .getByRole("row")
        .filter({ hasText: "invalid-one.srt" });
      await expect(duplicateSourceRows).toHaveCount(2);
      await expect(
        duplicateSourceRows.getByText("Failed", { exact: true })
      ).toHaveCount(2);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("coffee banner appears at each 20-file boundary, even with tasks visible", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-coffee-")
  );
  const subtitlePath = path.join(temporaryDirectory, "coffee-test.srt");
  writeFileSync(
    subtitlePath,
    "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
    "utf8"
  );

  try {
    const app = await electron.launch({ args: [".", "--no-sandbox"] });
    try {
      const page = await app.firstWindow();
      await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem("language", JSON.stringify("en-US"));
        localStorage.setItem("translation_success_count", "19");
        localStorage.setItem("api_keys", JSON.stringify(["test-key"]));
        localStorage.setItem(
          "api_host",
          JSON.stringify("http://example.com/v1")
        );
        localStorage.setItem("model", JSON.stringify("test-model"));
        localStorage.setItem("translate_lang", JSON.stringify("English"));
      });
      await page.reload();

      await page.locator('input[type="file"]').setInputFiles(subtitlePath);
      const taskDialog = page.getByRole("dialog");
      await expect(taskDialog).toBeVisible();
      await taskDialog.getByRole("button", { name: "Add task" }).click();

      const taskRow = page
        .getByRole("row")
        .filter({ hasText: "coffee-test.srt" });
      const coffeeBanner = page.getByRole("region", {
        name: "Buy Me a Coffee",
      });
      await expect(taskRow).toBeVisible();
      await expect(coffeeBanner).not.toBeVisible();

      const sendCompletedTranslations = (
        completions: Array<{ taskId: string; filePath: string }>
      ) =>
        app.evaluate(({ BrowserWindow }, completedTasks) => {
          const mainWindow = BrowserWindow.getAllWindows().find(
            (window) => !window.isDestroyed()
          );
          if (!mainWindow) throw new Error("Main window not found");

          for (const { taskId, filePath } of completedTasks) {
            mainWindow.webContents.send("batch-progress", {
              taskId,
              filePath,
              progress: 100,
              status: "done",
            });
          }
        }, completions);
      const readSuccessCount = () =>
        page.evaluate(() =>
          JSON.parse(
            localStorage.getItem("translation_success_count") ?? "0"
          )
        );

      const firstTask = {
        taskId: "11111111-1111-4111-8111-111111111111",
        filePath: subtitlePath,
      };
      await sendCompletedTranslations([firstTask]);
      await expect.poll(readSuccessCount).toBe(20);
      await expect(taskRow).toBeVisible();
      await expect(coffeeBanner).toBeVisible();

      await coffeeBanner.getByRole("button", { name: "Close" }).click();
      await expect(coffeeBanner).not.toBeVisible();

      // A repeated completion event for the same attempt must not count twice.
      await sendCompletedTranslations([firstTask]);
      await expect.poll(readSuccessCount).toBe(20);
      await expect(coffeeBanner).not.toBeVisible();

      await sendCompletedTranslations(
        Array.from(
          { length: 19 },
          (_, index) => ({
            taskId: `00000000-0000-4000-8000-${String(index + 21).padStart(12, "0")}`,
            filePath: `completed-${index + 21}.srt`,
          })
        )
      );
      await expect.poll(readSuccessCount).toBe(39);
      await expect(coffeeBanner).not.toBeVisible();

      await sendCompletedTranslations([
        {
          taskId: "00000000-0000-4000-8000-000000000040",
          filePath: "completed-40.srt",
        },
      ]);
      await expect.poll(readSuccessCount).toBe(40);
      await expect(coffeeBanner).toBeVisible();
      await coffeeBanner.getByRole("button", { name: "Close" }).click();
      await expect(coffeeBanner).not.toBeVisible();

      await sendCompletedTranslations(
        Array.from(
          { length: 19 },
          (_, index) => ({
            taskId: `00000000-0000-4000-8000-${String(index + 41).padStart(12, "0")}`,
            filePath: `completed-${index + 41}.srt`,
          })
        )
      );
      await expect.poll(readSuccessCount).toBe(59);
      await expect(coffeeBanner).not.toBeVisible();

      // If React batches enough completions to cross 60 and 80 together,
      // both prompts must remain queued instead of collapsing into one.
      await sendCompletedTranslations(
        Array.from(
          { length: 21 },
          (_, index) => ({
            taskId: `00000000-0000-4000-8000-${String(index + 60).padStart(12, "0")}`,
            filePath: `completed-${index + 60}.srt`,
          })
        )
      );
      await expect.poll(readSuccessCount).toBe(80);
      await expect(coffeeBanner).toBeVisible();
      await coffeeBanner.getByRole("button", { name: "Close" }).click();
      await expect(coffeeBanner).toBeVisible();
      await coffeeBanner.getByRole("button", { name: "Close" }).click();
      await expect(coffeeBanner).not.toBeVisible();

      await page.reload();
      await expect(
        page.getByRole("button", { name: "Choose files" })
      ).toBeVisible();
      await expect(coffeeBanner).not.toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
