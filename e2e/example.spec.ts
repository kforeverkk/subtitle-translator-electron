import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import iconv from "iconv-lite";
import assParser from "ass-parser";

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

function createAssSource(fontName: string, text: string): string {
  return `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},20,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0000,0000,0000,,${text}
`;
}

function createAssCheckpointSubtitle(
  source: string,
  translatedText: string
): {
  full: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
} {
  const full = assParser(source) as Array<{
    section?: string;
    body?: Array<{ key?: string; value?: unknown }>;
  }>;
  const dialogue = full
    .find((section) => section.section === "Events")
    ?.body?.find((entry) => entry.key === "Dialogue")?.value as
    | Record<string, string>
    | undefined;
  if (!dialogue) throw new Error("ASS fixture has no dialogue");
  return {
    full: full as Array<Record<string, unknown>>,
    events: [
      {
        type: "cue",
        data: {
          text: dialogue.Text,
          start: dialogue.Start,
          end: dialogue.End,
          translatedText,
        },
      },
    ],
  };
}

function isContentAnalysisRequest(requestBodyText: string): boolean {
  return (
    requestBodyText.includes("subtitle content analyst") ||
    (requestBodyText.includes("plotSummary") &&
      requestBodyText.includes("glossary"))
  );
}

function isLanguageDetectionRequest(requestBodyText: string): boolean {
  return requestBodyText.includes("Detect the primary spoken language");
}

async function startMockOpenAiServer(options: {
  streamDelayMs?: number | ((requestBodyText: string) => number);
  getStreamElements?: (requestBodyText: string) => string[];
  getStreamResponse?: (
    requestBodyText: string,
    requestNumber: number
  ) => {
    status?: number;
    empty?: boolean;
    elements?: string[];
    errorMessage?: string;
    responseHeaders?: Record<string, string>;
  };
  getDetectedLanguage?: (
    requestBodyText: string,
    requestNumber: number
  ) => string;
  getAnalysisResponse?: (
    requestBodyText: string,
    requestNumber: number
  ) => {
    status?: number;
    output?: unknown;
    errorMessage?: string;
  };
  onRequest?: (request: {
    startedAt: number;
    authorization?: string;
    bodyText: string;
  }) => void;
  onResponseClose?: (response: {
    bodyText: string;
    completed: boolean;
  }) => void;
} = {}): Promise<{
  apiHost: string;
  close: () => Promise<void>;
}> {
  let streamRequestCount = 0;
  let languageRequestCount = 0;
  let analysisRequestCount = 0;
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
        let responseCompleted = false;
        response.once("finish", () => {
          responseCompleted = true;
        });
        response.once("close", () => {
          options.onResponseClose?.({
            bodyText: requestBodyText,
            completed: responseCompleted,
          });
        });
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
          streamRequestCount++;
          const streamResponse = options.getStreamResponse?.(
            requestBodyText,
            streamRequestCount
          );
          if (streamResponse?.status) {
            response.statusCode = streamResponse.status;
            response.setHeader("Content-Type", "application/json");
            for (const [name, value] of Object.entries(
              streamResponse.responseHeaders ?? {}
            )) {
              response.setHeader(name, value);
            }
            response.end(
              JSON.stringify({
                error: {
                  message:
                    streamResponse.errorMessage ??
                    `Mock HTTP ${streamResponse.status}`,
                  type: "mock_error",
                },
              })
            );
            return;
          }

          const streamDelayMs =
            typeof options.streamDelayMs === "function"
              ? options.streamDelayMs(requestBodyText)
              : options.streamDelayMs;
          if (streamDelayMs) {
            await wait(streamDelayMs);
          }
          response.setHeader("Content-Type", "text/event-stream");
          if (streamResponse?.empty) {
            response.end();
            return;
          }

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
                        streamResponse?.elements ??
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

        if (isContentAnalysisRequest(requestBodyText)) {
          analysisRequestCount++;
          const analysisResponse = options.getAnalysisResponse?.(
            requestBodyText,
            analysisRequestCount
          );
          if (analysisResponse?.status) {
            response.statusCode = analysisResponse.status;
            response.setHeader("Content-Type", "application/json");
            response.end(
              JSON.stringify({
                error: {
                  message:
                    analysisResponse.errorMessage ??
                    `Mock HTTP ${analysisResponse.status}`,
                  type: "mock_analysis_error",
                },
              })
            );
            return;
          }

          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              id: "chatcmpl-analysis-test",
              object: "chat.completion",
              created,
              model: "test-model",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: JSON.stringify(
                      analysisResponse?.output ?? {
                        plotSummary:
                          "A mock subtitle plot summary for consistent translation.",
                        glossary: [],
                      }
                    ),
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

        languageRequestCount++;
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
                  content: JSON.stringify({
                    language:
                      options.getDetectedLanguage?.(
                        requestBodyText,
                        languageRequestCount
                      ) ?? "Chinese",
                  }),
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

async function runSingleSubtitleTranslation(
  page: Page,
  {
    apiHost,
    sourcePath,
    taskId,
    outputFormat = "srt-translation",
  }: {
    apiHost: string;
    sourcePath: string;
    taskId: string;
    outputFormat?: "srt-translation" | "srt-bilingual";
  }
): Promise<{
  status: string;
  error?: string;
  outputPath?: string;
  progress?: number;
  currentCue?: number;
  totalCues?: number;
}> {
  return page.evaluate(
    ({ apiHost, sourcePath, taskId, outputFormat }) =>
      new Promise<{
        status: string;
        error?: string;
        outputPath?: string;
      }>((resolve, reject) => {
        const removeListener = window.electronAPI.onBatchProgress((update) => {
          if (
            update.taskId === taskId &&
            (update.status === "done" || update.status === "error")
          ) {
            removeListener();
            resolve(update);
          }
        });
        window.electronAPI
          .translateBatch({
            files: [{ taskId, path: sourcePath, name: "movie.srt" }],
            params: {
              apiKeys: ["test-key"],
              apiHost,
              model: "test-model",
              prompt: "Translate every cue to {{lang}}. {{additional}}",
              lang: "English",
              additional: "",
              temperature: 1,
              outputFormat,
              assFonts: { translationFont: "", originalFont: "" },
              concurrency: 1,
              delay: 0,
              requestsPerMinute: 1_000,
              contextSize: 5,
            },
          })
          .catch(reject);
      }),
    { apiHost, sourcePath, taskId, outputFormat }
  );
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

test("closing the main window cancels translation and preserves its checkpoint for resume", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-window-close-")
  );
  const sourcePath = path.join(temporaryDirectory, "window-close.srt");
  const outputPath = path.join(temporaryDirectory, "window-close.en.srt");
  const taskId = "12121212-1212-4212-8212-121212121212";
  const checkpointPath = path.join(
    temporaryDirectory,
    `window-close.translation.${taskId.replaceAll("-", "")}.json`
  );
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );

  let delayTranslationResponse = true;
  let abortedTranslationResponses = 0;
  const requestBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    streamDelayMs: (requestBodyText) =>
      delayTranslationResponse && !isLanguageDetectionRequest(requestBodyText)
        ? 2_000
        : 0,
    getStreamElements: () => ["Hello"],
    onRequest: ({ bodyText }) => requestBodies.push(bodyText),
    onResponseClose: ({ bodyText, completed }) => {
      if (
        !completed &&
        !isLanguageDetectionRequest(bodyText) &&
        !isContentAnalysisRequest(bodyText)
      ) {
        abortedTranslationResponses++;
      }
    },
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const auxiliaryWindow = new BrowserWindow({ show: false });
      (
        globalThis as typeof globalThis & {
          __subtitleTranslatorCloseTestAuxWindowId?: number;
        }
      ).__subtitleTranslatorCloseTestAuxWindowId = auxiliaryWindow.id;
    });

    await page.evaluate(
      ({ apiHost, sourcePath, taskId }) => {
        void window.electronAPI
          .translateBatch({
            files: [
              {
                taskId,
                path: sourcePath,
                name: "window-close.srt",
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
          })
          .catch(() => undefined);
      },
      { apiHost: mockServer.apiHost, sourcePath, taskId }
    );

    await expect
      .poll(
        () =>
          requestBodies.filter(
            (body) =>
              !isLanguageDetectionRequest(body) &&
              !isContentAnalysisRequest(body)
          ).length
      )
      .toBe(1);
    await expect.poll(() => existsSync(checkpointPath)).toBe(true);

    await app.evaluate(({ BrowserWindow }) => {
      const closeTestGlobal = globalThis as typeof globalThis & {
        __subtitleTranslatorCloseTestAuxWindowId?: number;
      };
      const auxiliaryId =
        closeTestGlobal.__subtitleTranslatorCloseTestAuxWindowId;
      const mainWindow = BrowserWindow.getAllWindows().find(
        (window) =>
          !window.isDestroyed() &&
          window.id !== auxiliaryId &&
          !window.webContents.getURL().includes("#/about")
      );
      if (!mainWindow) throw new Error("Main window not found");
      mainWindow.close();
    });

    await expect.poll(() => abortedTranslationResponses).toBe(1);
    expect(existsSync(checkpointPath)).toBe(true);
    expect(existsSync(outputPath)).toBe(false);

    delayTranslationResponse = false;
    await wait(250);
    const resumedPagePromise = app.waitForEvent("window");
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit("activate", {} as Electron.Event, false);
    });
    const resumedPage = await resumedPagePromise;
    const result = await runSingleSubtitleTranslation(resumedPage, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });

    expect(result.status).toBe("done");
    expect(readFileSync(outputPath, "utf8")).toContain("Hello");
    expect(existsSync(checkpointPath)).toBe(false);

    await app.evaluate(({ BrowserWindow }) => {
      const closeTestGlobal = globalThis as typeof globalThis & {
        __subtitleTranslatorCloseTestAuxWindowId?: number;
      };
      const auxiliaryId =
        closeTestGlobal.__subtitleTranslatorCloseTestAuxWindowId;
      if (auxiliaryId !== undefined) {
        const auxiliaryWindow = BrowserWindow.fromId(auxiliaryId);
        if (auxiliaryWindow && !auxiliaryWindow.isDestroyed()) {
          auxiliaryWindow.close();
        }
      }
      delete closeTestGlobal.__subtitleTranslatorCloseTestAuxWindowId;
    });
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
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
  const configuredRequestDelayMs = 300;
  const minimumObservedServerIntervalMs = 150;
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
      async ({
        apiHost,
        configuredRequestDelayMs,
        englishSourcePath,
        frenchSourcePath,
      }) => {
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
          delay: configuredRequestDelayMs,
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
        configuredRequestDelayMs,
        englishSourcePath,
        frenchSourcePath,
      }
    );

    expect(requestStarts).toHaveLength(2);
    const sortedRequestStarts = [...requestStarts].sort(
      (left, right) => left - right
    );
    for (let index = 1; index < sortedRequestStarts.length; index++) {
      expect(
        sortedRequestStarts[index] - sortedRequestStarts[index - 1]
      ).toBeGreaterThanOrEqual(minimumObservedServerIntervalMs);
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

test("a translated-only batch skips source language detection", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-single-rpm-")
  );
  const sourcePath = path.join(temporaryDirectory, "single-source.srt");
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  const requestBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    getStreamElements: () => ["Hello"],
    onRequest: ({ bodyText }) => requestBodies.push(bodyText),
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

    expect(requestBodies).toHaveLength(1);
    expect(isLanguageDetectionRequest(requestBodies[0])).toBe(false);
    expect(
      readFileSync(path.join(temporaryDirectory, "single-source.en.srt"), "utf8")
    ).toContain("Hello");
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("an empty stream retries twice and succeeds on the third translation request", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-empty-stream-success-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const taskId = "12121212-1212-4212-8212-121212121212";
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  let streamRequests = 0;
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      if (JSON.parse(bodyText).stream === true) streamRequests++;
    },
    getStreamResponse: (_bodyText, requestNumber) =>
      requestNumber < 3
        ? { empty: true }
        : { elements: ["Recovered translation"] },
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });

    expect(progress.status, progress.error).toBe("done");
    expect(streamRequests).toBe(3);
    expect(
      readFileSync(path.join(temporaryDirectory, "movie.en.srt"), "utf8")
    ).toContain("Recovered translation");
    expect(
      readdirSync(temporaryDirectory).filter(
        (name) =>
          name.includes(".translation.") || name.endsWith(".backup.json")
      )
    ).toEqual([]);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("translated-only self-collision repeats the language suffix and preserves the input", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-single-self-collision-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.en.srt");
  const outputPath = path.join(temporaryDirectory, "movie.en.en.srt");
  const taskId = "21212121-2121-4121-8121-212121212121";
  const sourceText =
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n";
  writeFileSync(sourcePath, sourceText, "utf8");
  const mockServer = await startMockOpenAiServer({
    getDetectedLanguage: () => "Chinese",
    getStreamElements: () => ["Hello"],
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });

    expect(progress.status, progress.error).toBe("done");
    expect(progress.outputPath).toBe(outputPath);
    expect(readFileSync(sourcePath, "utf8")).toBe(sourceText);
    expect(readFileSync(outputPath, "utf8")).toContain("Hello");
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bilingual self-collision appends the language suffix and preserves the input", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-bilingual-self-collision-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.en-zh.srt");
  const outputPath = path.join(
    temporaryDirectory,
    "movie.en-zh.en-zh.srt"
  );
  const taskId = "19191919-1919-4919-8919-191919191919";
  const sourceText =
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n";
  writeFileSync(sourcePath, sourceText, "utf8");
  const mockServer = await startMockOpenAiServer({
    getDetectedLanguage: () => "Chinese",
    getStreamElements: () => ["Hello"],
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
      outputFormat: "srt-bilingual",
    });

    expect(progress.status, progress.error).toBe("done");
    expect(progress.outputPath).toBe(outputPath);
    expect(readFileSync(sourcePath, "utf8")).toBe(sourceText);
    expect(readFileSync(outputPath, "utf8")).toContain("Hello\n你好");
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bilingual translation still overwrites an unrelated existing destination", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-existing-output-overwrite-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const outputPath = path.join(temporaryDirectory, "movie.en-zh.srt");
  const taskId = "20202020-2020-4020-8020-202020202020";
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  writeFileSync(outputPath, "unrelated existing subtitle", "utf8");
  const mockServer = await startMockOpenAiServer({
    getDetectedLanguage: () => "Chinese",
    getStreamElements: () => ["Replacement translation"],
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
      outputFormat: "srt-bilingual",
    });

    expect(progress.status, progress.error).toBe("done");
    expect(progress.outputPath).toBe(outputPath);
    expect(readFileSync(outputPath, "utf8")).toContain(
      "Replacement translation"
    );
    expect(readFileSync(outputPath, "utf8")).not.toContain(
      "unrelated existing subtitle"
    );
    expect(existsSync(path.join(temporaryDirectory, "movie.en-zh.2.srt"))).toBe(
      false
    );
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("one task output cannot replace a later input in the same batch", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-cross-input-protection-")
  );
  const firstSourcePath = path.join(temporaryDirectory, "movie.srt");
  const secondSourcePath = path.join(
    temporaryDirectory,
    "movie.en-zh.srt"
  );
  const firstOutputPath = path.join(
    temporaryDirectory,
    "movie.en-zh.en-zh.srt"
  );
  const secondOutputPath = path.join(
    temporaryDirectory,
    "movie.en-ja.srt"
  );
  const firstTaskId = "22222222-2222-4222-8222-222222222222";
  const secondTaskId = "23232323-2323-4323-8323-232323232323";
  const firstSourceText =
    "1\n00:00:00,000 --> 00:00:01,000\n中文来源 A\n";
  const secondSourceText =
    "1\n00:00:00,000 --> 00:00:01,000\n日本語ソース B\n";
  writeFileSync(firstSourcePath, firstSourceText, "utf8");
  writeFileSync(secondSourcePath, secondSourceText, "utf8");
  const mockServer = await startMockOpenAiServer({
    getDetectedLanguage: (requestBodyText) =>
      requestBodyText.includes("日本語ソース B") ? "Japanese" : "Chinese",
    getStreamElements: (requestBodyText) =>
      requestBodyText.includes("日本語ソース B")
        ? ["English from B"]
        : ["English from A"],
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progressByTask = await page.evaluate(
      ({
        apiHost,
        firstSourcePath,
        secondSourcePath,
        firstTaskId,
        secondTaskId,
      }) =>
        new Promise<Record<string, { status: string; error?: string }>>(
          (resolve, reject) => {
            const terminal = new Map<
              string,
              { status: string; error?: string }
            >();
            const taskIds = new Set([firstTaskId, secondTaskId]);
            const removeListener = window.electronAPI.onBatchProgress(
              (update) => {
                if (
                  taskIds.has(update.taskId) &&
                  (update.status === "done" || update.status === "error")
                ) {
                  terminal.set(update.taskId, update);
                  if (terminal.size === taskIds.size) {
                    removeListener();
                    resolve(Object.fromEntries(terminal));
                  }
                }
              }
            );
            window.electronAPI
              .translateBatch({
                files: [
                  {
                    taskId: firstTaskId,
                    path: firstSourcePath,
                    name: "movie.srt",
                  },
                  {
                    taskId: secondTaskId,
                    path: secondSourcePath,
                    name: "movie.en-zh.srt",
                  },
                ],
                params: {
                  apiKeys: ["test-key"],
                  apiHost,
                  model: "test-model",
                  prompt:
                    "Translate every cue to {{lang}}. {{additional}}",
                  lang: "English",
                  additional: "",
                  temperature: 1,
                  outputFormat: "srt-bilingual",
                  assFonts: {
                    translationFont: "",
                    originalFont: "",
                  },
                  concurrency: 1,
                  delay: 0,
                  requestsPerMinute: 1_000,
                  contextSize: 5,
                },
              })
              .catch(reject);
          }
        ),
      {
        apiHost: mockServer.apiHost,
        firstSourcePath,
        secondSourcePath,
        firstTaskId,
        secondTaskId,
      }
    );

    expect(progressByTask[firstTaskId]?.status).toBe("done");
    expect(progressByTask[secondTaskId]?.status).toBe("done");
    expect(readFileSync(secondSourcePath, "utf8")).toBe(secondSourceText);
    expect(readFileSync(firstOutputPath, "utf8")).toContain(
      "English from A"
    );
    expect(readFileSync(secondOutputPath, "utf8")).toContain(
      "English from B"
    );
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("subtitle output rename failure preserves the last valid file and checkpoint", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-output-rename-failure-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const outputPath = path.join(temporaryDirectory, "movie.en.srt");
  const taskId = "14141414-1414-4414-8414-141414141414";
  const checkpointPath = path.join(
    temporaryDirectory,
    `movie.translation.${taskId.replaceAll("-", "")}.json`
  );
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  writeFileSync(outputPath, "last valid subtitle", "utf8");
  const mockServer = await startMockOpenAiServer({
    getStreamElements: () => ["Translated subtitle"],
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    await app.evaluate(() => {
      const mainGlobal = globalThis as typeof globalThis & {
        __subtitleTranslatorOutputRenameHook?: (
          temporaryPath: string,
          outputPath: string
        ) => Promise<void>;
      };
      mainGlobal.__subtitleTranslatorOutputRenameHook = async () => {
        throw Object.assign(new Error("forced subtitle rename failure"), {
          code: "EPERM",
        });
      };
    });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });

    expect(progress.status).toBe("error");
    expect(readFileSync(outputPath, "utf8")).toBe("last valid subtitle");
    expect(existsSync(checkpointPath)).toBe(true);
    expect(
      readdirSync(temporaryDirectory).filter(
        (name) => name.startsWith("movie.en.srt.") && name.endsWith(".tmp")
      )
    ).toEqual([]);
  } finally {
    if (app) {
      await app.evaluate(() => {
        const mainGlobal = globalThis as typeof globalThis & {
          __subtitleTranslatorOutputRenameHook?: unknown;
        };
        delete mainGlobal.__subtitleTranslatorOutputRenameHook;
      }).catch(() => undefined);
    }
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("subtitle output recovers after a failed partial atomic commit", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-output-rename-recovery-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const outputPath = path.join(temporaryDirectory, "movie.en.srt");
  const taskId = "15151515-1515-4515-8515-151515151515";
  const checkpointPath = path.join(
    temporaryDirectory,
    `movie.translation.${taskId.replaceAll("-", "")}.json`
  );
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  writeFileSync(outputPath, "last valid subtitle", "utf8");
  const mockServer = await startMockOpenAiServer({
    getStreamElements: () => ["Recovered translated subtitle"],
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    await app.evaluate(() => {
      const mainGlobal = globalThis as typeof globalThis & {
        __subtitleTranslatorOutputRenameAttempts?: number;
        __subtitleTranslatorOutputBeforeRecovery?: string;
        __subtitleTranslatorOutputRenameHook?: (
          temporaryPath: string,
          outputPath: string
        ) => Promise<void>;
      };
      mainGlobal.__subtitleTranslatorOutputRenameAttempts = 0;
      mainGlobal.__subtitleTranslatorOutputRenameHook = async (
        temporaryPath,
        outputPath
      ) => {
        mainGlobal.__subtitleTranslatorOutputRenameAttempts =
          (mainGlobal.__subtitleTranslatorOutputRenameAttempts ?? 0) + 1;
        if (mainGlobal.__subtitleTranslatorOutputRenameAttempts <= 5) {
          throw Object.assign(new Error("forced partial rename failure"), {
            code: "EPERM",
          });
        }
        const nodeFs = process.getBuiltinModule("node:fs");
        mainGlobal.__subtitleTranslatorOutputBeforeRecovery =
          nodeFs.readFileSync(outputPath, "utf8");
        await nodeFs.promises.rename(temporaryPath, outputPath);
      };
    });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });
    const observed = await app.evaluate(() => {
      const mainGlobal = globalThis as typeof globalThis & {
        __subtitleTranslatorOutputRenameAttempts?: number;
        __subtitleTranslatorOutputBeforeRecovery?: string;
      };
      return {
        attempts: mainGlobal.__subtitleTranslatorOutputRenameAttempts,
        beforeRecovery: mainGlobal.__subtitleTranslatorOutputBeforeRecovery,
      };
    });

    expect(progress.status, progress.error).toBe("done");
    expect(observed).toEqual({
      attempts: 6,
      beforeRecovery: "last valid subtitle",
    });
    expect(readFileSync(outputPath, "utf8")).toContain(
      "Recovered translated subtitle"
    );
    expect(existsSync(checkpointPath)).toBe(false);
  } finally {
    if (app) {
      await app.evaluate(() => {
        const mainGlobal = globalThis as typeof globalThis & {
          __subtitleTranslatorOutputRenameAttempts?: unknown;
          __subtitleTranslatorOutputBeforeRecovery?: unknown;
          __subtitleTranslatorOutputRenameHook?: unknown;
        };
        delete mainGlobal.__subtitleTranslatorOutputRenameAttempts;
        delete mainGlobal.__subtitleTranslatorOutputBeforeRecovery;
        delete mainGlobal.__subtitleTranslatorOutputRenameHook;
      }).catch(() => undefined);
    }
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("three empty streams fail only after the third request and keep the checkpoint", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-empty-stream-failure-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const taskId = "13131313-1313-4313-8313-131313131313";
  const checkpointPath = path.join(
    temporaryDirectory,
    `movie.translation.${taskId.replaceAll("-", "")}.json`
  );
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  let streamRequests = 0;
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      if (JSON.parse(bodyText).stream === true) streamRequests++;
    },
    getStreamResponse: () => ({ empty: true }),
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });

    expect(progress.status).toBe("error");
    expect(progress.error).toBe("ERR_INCOMPLETE_MODEL_OUTPUT");
    expect(streamRequests).toBe(3);
    expect(
      (
        JSON.parse(readFileSync(checkpointPath, "utf8")) as {
          task?: { id?: string };
        }
      ).task?.id
    ).toBe(taskId);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("a failed later chunk keeps partial progress instead of resetting to zero", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-partial-failure-progress-")
  );
  const sourcePath = path.join(temporaryDirectory, "partial-progress.srt");
  const taskId = "20202020-2020-4020-8020-202020202020";
  const checkpointPath = path.join(
    temporaryDirectory,
    `partial-progress.translation.${taskId.replaceAll("-", "")}.json`
  );
  const formatTimestamp = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `00:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},000`;
  };
  const sourceText = Array.from({ length: 60 }, (_, index) => {
    return [
      String(index + 1),
      `${formatTimestamp(index)} --> ${formatTimestamp(index + 1)}`,
      `原文 ${index + 1}`,
      "",
    ].join("\n");
  }).join("\n");
  writeFileSync(sourcePath, sourceText, "utf8");

  let streamRequests = 0;
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      if (JSON.parse(bodyText).stream === true) streamRequests++;
    },
    getStreamResponse: (_bodyText, requestNumber) =>
      requestNumber === 1
        ? {
            elements: Array.from(
              { length: 20 },
              (_, index) => `Translation ${index + 1}`
            ),
          }
        : { empty: true },
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });

    expect(progress.status).toBe("error");
    expect(progress.error).toBe("ERR_INCOMPLETE_MODEL_OUTPUT");
    expect(progress.progress).toBeCloseTo(100 / 3);
    expect(progress.currentCue).toBe(20);
    expect(progress.totalCues).toBe(60);
    expect(streamRequests).toBe(4);

    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
      subtitle?: Array<{
        type?: string;
        data?: { translatedText?: string };
      }>;
    };
    expect(
      checkpoint.subtitle?.filter(
        (cue) =>
          cue.type === "cue" &&
          typeof cue.data?.translatedText === "string" &&
          cue.data.translatedText.trim().length > 0
      )
    ).toHaveLength(20);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("required content analysis fails after three invalid glossary responses without translating", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-required-analysis-")
  );
  const sourcePath = path.join(temporaryDirectory, "required-analysis.srt");
  const taskId = "18181818-1818-4818-8818-181818181818";
  const sourceText = Array.from({ length: 20 }, (_, index) => {
    const startSecond = String(index).padStart(2, "0");
    const endSecond = String(index + 1).padStart(2, "0");
    return `${index + 1}\n00:00:${startSecond},000 --> 00:00:${endSecond},000\n原文 ${index + 1}\n`;
  }).join("\n");
  writeFileSync(sourcePath, sourceText, "utf8");

  let analysisRequests = 0;
  let translationRequests = 0;
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      const requestBody = JSON.parse(bodyText) as { stream?: boolean };
      if (requestBody.stream === true) {
        translationRequests++;
      } else if (isContentAnalysisRequest(bodyText)) {
        analysisRequests++;
      }
    },
    getAnalysisResponse: () => ({
      output: {
        plotSummary: "This response intentionally omits the glossary field.",
      },
    }),
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });

    expect(progress.status).toBe("error");
    expect(progress.error).toContain("ERR_INCOMPLETE_MODEL_OUTPUT");
    expect(analysisRequests).toBe(3);
    expect(translationRequests).toBe(0);
    expect(
      existsSync(
        path.join(temporaryDirectory, "required-analysis.en.srt")
      )
    ).toBe(false);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("bilingual resume keeps its first detected-language filename", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-bilingual-resume-name-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const taskId = "16161616-1616-4616-8616-161616161616";
  const checkpointPath = path.join(
    temporaryDirectory,
    `movie.translation.${taskId.replaceAll("-", "")}.json`
  );
  const sourceText = Array.from({ length: 21 }, (_, index) => {
    const startSecond = String(index).padStart(2, "0");
    const endSecond = String(index + 1).padStart(2, "0");
    return `${index + 1}\n00:00:${startSecond},000 --> 00:00:${endSecond},000\n原文 ${index + 1}\n`;
  }).join("\n");
  writeFileSync(sourcePath, sourceText, "utf8");

  let languageDetectionRequests = 0;
  let analysisRequests = 0;
  const translationRequestBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      if (JSON.parse(bodyText).stream === true) {
        translationRequestBodies.push(bodyText);
      } else if (isContentAnalysisRequest(bodyText)) {
        analysisRequests++;
      } else if (isLanguageDetectionRequest(bodyText)) {
        languageDetectionRequests++;
      }
    },
    getDetectedLanguage: (_bodyText, requestNumber) =>
      requestNumber === 1 ? "Chinese" : "Japanese",
    getStreamResponse: (_bodyText, requestNumber) => {
      if (requestNumber === 1) {
        return {
          elements: Array.from(
            { length: 20 },
            (_, index) => `Translated ${index + 1}`
          ),
        };
      }
      if (requestNumber <= 4) return { empty: true };
      return { elements: ["Translated 21"] };
    },
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    let page = await app.firstWindow();
    const failedProgress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
      outputFormat: "srt-bilingual",
    });

    expect(failedProgress.status).toBe("error");
    expect(languageDetectionRequests).toBe(1);
    expect(analysisRequests).toBe(1);
    expect(existsSync(path.join(temporaryDirectory, "movie.en-zh.srt"))).toBe(
      true
    );
    expect(
      (
        JSON.parse(readFileSync(checkpointPath, "utf8")) as {
          analysis?: string;
          output?: {
            format?: string;
            detectedSourceLanguage?: string;
            fileName?: string;
          };
        }
      )
    ).toEqual(
      expect.objectContaining({
        analysis: expect.stringContaining("## Glossary"),
        output: {
          format: "srt-bilingual",
          detectedSourceLanguage: "Chinese",
          fileName: "movie.en-zh.srt",
        },
      })
    );
    expect(
      (
        JSON.parse(readFileSync(checkpointPath, "utf8")) as {
          output?: {
            format?: string;
            detectedSourceLanguage?: string;
            fileName?: string;
          };
        }
      ).output
    ).toEqual({
      format: "srt-bilingual",
      detectedSourceLanguage: "Chinese",
      fileName: "movie.en-zh.srt",
    });

    await app.close();
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    page = await app.firstWindow();
    const resumedProgress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
      outputFormat: "srt-bilingual",
    });

    expect(resumedProgress.status, resumedProgress.error).toBe("done");
    expect(languageDetectionRequests).toBe(1);
    expect(analysisRequests).toBe(1);
    expect(translationRequestBodies.at(-1)).toContain(
      "A mock subtitle plot summary for consistent translation."
    );
    expect(translationRequestBodies.at(-1)).toContain("## Glossary");
    const completedOutput = readFileSync(
      path.join(temporaryDirectory, "movie.en-zh.srt"),
      "utf8"
    );
    expect(completedOutput).toContain("Translated 1");
    expect(completedOutput).toContain("Translated 21");
    expect(existsSync(path.join(temporaryDirectory, "movie.en-ja.srt"))).toBe(
      false
    );
    expect(
      existsSync(path.join(temporaryDirectory, "movie.en-original.srt"))
    ).toBe(false);
    expect(existsSync(checkpointPath)).toBe(false);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("legacy checkpoint backfills a stable bilingual output identity", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-bilingual-backfill-")
  );
  const sourcePath = path.join(temporaryDirectory, "legacy.srt");
  const taskId = "17171717-1717-4717-8717-171717171717";
  const checkpointPath = path.join(
    temporaryDirectory,
    `legacy.translation.${taskId.replaceAll("-", "")}.json`
  );
  const sourceText = "1\n00:00:00,000 --> 00:00:01,000\n你好\n";
  writeFileSync(sourcePath, sourceText, "utf8");
  const sourceInfo = statSync(sourcePath);
  const apiPrompt = "Translate every cue to {{lang}}. {{additional}}";
  let languageDetectionRequests = 0;
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      if (JSON.parse(bodyText).stream !== true) {
        languageDetectionRequests++;
      }
    },
    getStreamResponse: () => ({ empty: true }),
  });
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      version: 3,
      format: "srt",
      source: {
        name: "legacy.srt",
        fingerprint: {
          size: sourceInfo.size,
          mtimeMs: sourceInfo.mtimeMs,
        },
      },
      translation: {
        configFingerprint: createTestTranslationConfigFingerprint({
          apiHost: mockServer.apiHost,
          model: "test-model",
          prompt: apiPrompt,
          lang: "English",
          additional: "",
          temperature: 1,
          contextSize: 5,
        }),
      },
      task: { id: taskId },
      subtitle: [
        {
          type: "cue",
          data: { start: 0, end: 1_000, text: "你好" },
        },
      ],
    }),
    "utf8"
  );

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
      outputFormat: "srt-bilingual",
    });

    expect(progress.status).toBe("error");
    expect(languageDetectionRequests).toBe(1);
    expect(
      (
        JSON.parse(readFileSync(checkpointPath, "utf8")) as {
          output?: {
            format?: string;
            detectedSourceLanguage?: string;
            fileName?: string;
          };
        }
      ).output
    ).toEqual({
      format: "srt-bilingual",
      detectedSourceLanguage: "Chinese",
      fileName: "legacy.en-zh.srt",
    });
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("legacy analysis restart discards partial translations before required analysis", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-legacy-analysis-restart-")
  );
  const sourcePath = path.join(temporaryDirectory, "legacy-analysis.srt");
  const taskId = "19191919-1919-4919-8919-191919191919";
  const checkpointPath = path.join(
    temporaryDirectory,
    `legacy-analysis.translation.${taskId.replaceAll("-", "")}.json`
  );
  const sourceCues = Array.from({ length: 20 }, (_, index) => ({
    type: "cue" as const,
    data: {
      start: index * 1_000,
      end: (index + 1) * 1_000,
      text: `原文 ${index + 1}`,
      ...(index < 5
        ? { translatedText: `Stale translation ${index + 1}` }
        : {}),
    },
  }));
  const sourceText = sourceCues
    .map((cue, index) => {
      const startSecond = String(index).padStart(2, "0");
      const endSecond = String(index + 1).padStart(2, "0");
      return `${index + 1}\n00:00:${startSecond},000 --> 00:00:${endSecond},000\n${cue.data.text}\n`;
    })
    .join("\n");
  writeFileSync(sourcePath, sourceText, "utf8");
  const sourceInfo = statSync(sourcePath);
  const apiPrompt = "Translate every cue to {{lang}}. {{additional}}";
  let analysisRequests = 0;
  const translatedCoreCounts: number[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      if (isContentAnalysisRequest(bodyText)) analysisRequests++;
      if (JSON.parse(bodyText).stream === true) {
        translatedCoreCounts.push(
          Number(
            bodyText.match(/exactly (\d+) translated strings/i)?.[1] ?? 0
          )
        );
      }
    },
    getStreamResponse: () => ({
      elements: Array.from(
        { length: 20 },
        (_, index) => `Fresh translation ${index + 1}`
      ),
    }),
  });
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      version: 3,
      format: "srt",
      source: {
        name: "legacy-analysis.srt",
        fingerprint: {
          size: sourceInfo.size,
          mtimeMs: sourceInfo.mtimeMs,
        },
      },
      translation: {
        configFingerprint: createTestTranslationConfigFingerprint({
          apiHost: mockServer.apiHost,
          model: "test-model",
          prompt: apiPrompt,
          lang: "English",
          additional: "",
          temperature: 1,
          contextSize: 5,
        }),
      },
      task: { id: taskId },
      output: {
        format: "srt-bilingual",
        detectedSourceLanguage: "Chinese",
        fileName: "legacy-analysis.en-zh.srt",
      },
      subtitle: sourceCues,
    }),
    "utf8"
  );

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
      outputFormat: "srt-bilingual",
    });

    expect(progress.status, progress.error).toBe("done");
    expect(analysisRequests).toBe(1);
    expect(translatedCoreCounts).toEqual([20]);
    const output = readFileSync(
      path.join(temporaryDirectory, "legacy-analysis.en-zh.srt"),
      "utf8"
    );
    expect(output).toContain("Fresh translation 1");
    expect(output).toContain("Fresh translation 20");
    expect(output).not.toContain("Stale translation");
    expect(
      readdirSync(temporaryDirectory).filter(
        (entry) =>
          entry.includes(".translation.") ||
          entry.endsWith(".backup.json")
      )
    ).toEqual([]);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("an HTTP 401 translation response is not retried like an empty stream", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-empty-stream-401-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const taskId = "14141414-1414-4414-8414-141414141414";
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  let streamRequests = 0;
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      if (JSON.parse(bodyText).stream === true) streamRequests++;
    },
    getStreamResponse: () => ({
      status: 401,
      errorMessage: "Invalid API key",
    }),
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });

    expect(progress.status).toBe("error");
    expect(progress.error).toContain("Invalid API key");
    expect(streamRequests).toBe(1);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("a retryable HTTP 429 stream error honors Retry-After before succeeding", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-empty-stream-429-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const taskId = "15151515-1515-4515-8515-151515151515";
  writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
    "utf8"
  );
  const streamRequestStarts: number[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText, startedAt }) => {
      if (JSON.parse(bodyText).stream === true) {
        streamRequestStarts.push(startedAt);
      }
    },
    getStreamResponse: (_bodyText, requestNumber) =>
      requestNumber === 1
        ? {
            status: 429,
            errorMessage: "Rate limit exceeded",
            responseHeaders: { "retry-after-ms": "1500" },
          }
        : { elements: ["Recovered after rate limit"] },
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await runSingleSubtitleTranslation(page, {
      apiHost: mockServer.apiHost,
      sourcePath,
      taskId,
    });

    expect(progress.status, progress.error).toBe("done");
    expect(streamRequestStarts).toHaveLength(2);
    expect(streamRequestStarts[1] - streamRequestStarts[0]).toBeGreaterThanOrEqual(
      1400
    );
    expect(
      readFileSync(path.join(temporaryDirectory, "movie.en.srt"), "utf8")
    ).toContain("Recovered after rate limit");
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

test("SSA input keeps styles and effects in real Electron ASS output", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-ssa-success-")
  );
  const sourcePath = path.join(temporaryDirectory, "styled-effects.ssa");
  writeFileSync(
    sourcePath,
    readFileSync(path.resolve("tests/fixtures/ssa/styled-effects.ssa"), "utf8"),
    "utf8"
  );
  const requestBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    getStreamElements: () => ["Translated one", "Translated two", "Translated three"],
    onRequest: ({ bodyText }) => requestBodies.push(bodyText),
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    const progress = await page.evaluate(
      ({ apiHost, sourcePath }) =>
        new Promise<{
          status: string;
          error?: string;
          outputPath?: string;
        }>((resolve, reject) => {
          const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
          const removeListener = window.electronAPI.onBatchProgress((update) => {
            if (
              update.taskId === taskId &&
              (update.status === "done" || update.status === "error")
            ) {
              removeListener();
              resolve(update);
            }
          });
          window.electronAPI
            .translateBatch({
              files: [{ taskId, path: sourcePath, name: "styled-effects.ssa" }],
              params: {
                apiKeys: ["test-key"],
                apiHost,
                model: "test-model",
                prompt: "Translate every cue to {{lang}}. {{additional}}",
                lang: "English",
                additional: "",
                temperature: 1,
                outputFormat: "ass-bilingual",
                assFonts: { translationFont: "", originalFont: "" },
                concurrency: 1,
                delay: 0,
                requestsPerMinute: 1_000,
                contextSize: 5,
              },
            })
            .catch(reject);
        }),
      { apiHost: mockServer.apiHost, sourcePath }
    );

    expect(progress.status, progress.error).toBe("done");
    expect(progress.outputPath).toBeTruthy();
    const output = readFileSync(progress.outputPath!, "utf8");
    expect(output).toContain("[V4+ Styles]");
    expect(output).toContain("Times New Roman,28,&H20FFFFFF");
    expect(output).toContain("Banner;20;0;10");
    expect(output).toContain("{\\pos(100,200)\\fad(100,200)\\i1\\1c&H112233&}Hello, world");
    expect(output).toContain("{\\rST Translation 0}Translated one");
    expect(output).not.toContain("Style: Default,Arial,20,");
    expect(requestBodies).toHaveLength(2);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("SSA conversion failure is explicit in the real GUI before API use", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-ssa-failure-")
  );
  const sourcePath = path.join(temporaryDirectory, "invalid-style.ssa");
  const invalidSource = readFileSync(
    path.resolve("tests/fixtures/ssa/attachments.ssa"),
    "utf8"
  ).replace(",2,10,10,10,0,1", ",12,10,10,10,0,1");
  writeFileSync(sourcePath, invalidSource, "utf8");
  const requestBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => requestBodies.push(bodyText),
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
        localStorage.setItem(
          "prompt",
          JSON.stringify("Translate every cue to {{lang}}. {{additional}}")
        );
        localStorage.setItem("translate_lang", JSON.stringify("English"));
        localStorage.setItem("delay", JSON.stringify(0));
        localStorage.setItem("requests_per_minute", JSON.stringify(1000));
        localStorage.setItem("translation_concurrency", JSON.stringify(1));
        localStorage.setItem(
          "subtitle_output_format",
          JSON.stringify("ass-bilingual")
        );
      },
      { apiHost: mockServer.apiHost }
    );
    await page.reload();

    await page.locator('input[type="file"]').setInputFiles(sourcePath);
    const taskDialog = page.getByRole("dialog");
    await expect(taskDialog).toBeVisible();
    await taskDialog.getByRole("button", { name: "Add task" }).click();

    const taskRow = page.getByRole("row").filter({ hasText: "invalid-style.ssa" });
    await expect(taskRow.getByText("Failed", { exact: true })).toBeVisible();
    await taskRow
      .getByRole("button", {
        name: "View translation details for invalid-style.ssa",
      })
      .click();
    await expect(page.getByRole("heading", { name: "Error details" })).toBeVisible();
    const details = page.locator("pre");
    await expect(details).toContainText("SSA to ASS format conversion failed");
    await expect(details).toContainText("style Default.Alignment");
    await expect(details).toContainText("12");
    await expect(details).toContainText("original subtitle was not overwritten");
    await expect(details).toContainText("choose SRT output");
    expect(requestBodies).toHaveLength(0);
    expect(readdirSync(temporaryDirectory).filter((name) => name.endsWith(".ass"))).toEqual([]);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("subtitle source identity resumes equivalent legacy-encoded content", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-source-identity-encoding-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const taskId = "77777777-7777-4777-8777-777777777777";
  const checkpointPath = path.join(
    temporaryDirectory,
    `movie.translation.${taskId.replaceAll("-", "")}.json`
  );
  const sentence = "简体中文字幕身份校验测试，这是一段足够长的原始字幕文本。";
  const sourceText = Array.from({ length: 20 }, () => sentence).join(" ");
  writeFileSync(
    sourcePath,
    iconv.encode(`1\n00:00:00,000 --> 00:00:02,000\n${sourceText}\n`, "gb18030")
  );
  const sourceInfo = statSync(sourcePath);
  const prompt = "Translate every cue to {{lang}}. {{additional}}";
  const requestBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => requestBodies.push(bodyText),
  });
  const configFingerprint = createTestTranslationConfigFingerprint({
    apiHost: mockServer.apiHost,
    model: "test-model",
    prompt,
    lang: "English",
    additional: "",
    temperature: 1,
    contextSize: 5,
  });
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      version: 3,
      format: "srt",
      source: {
        name: "movie.srt",
        fingerprint: { size: sourceInfo.size, mtimeMs: sourceInfo.mtimeMs },
      },
      translation: { configFingerprint },
      task: { id: taskId },
      subtitle: [
        {
          type: "cue",
          data: {
            start: 0,
            end: 2_000,
            text: sourceText,
            translatedText: "Preserved translation",
          },
        },
      ],
    }),
    "utf8"
  );

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    await page.evaluate(
      async ({ sourcePath, taskId, apiHost, prompt }) => {
        await window.electronAPI.translateBatch({
          files: [{ taskId, path: sourcePath, name: "movie.srt" }],
          params: {
            apiKeys: ["test-key"],
            apiHost,
            model: "test-model",
            prompt,
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
      { sourcePath, taskId, apiHost: mockServer.apiHost, prompt }
    );

    expect(
      requestBodies.filter((body) => JSON.parse(body).stream === true)
    ).toHaveLength(0);
    expect(
      readFileSync(path.join(temporaryDirectory, "movie.en.srt"), "utf8")
    ).toContain("Preserved translation");
    expect(readdirSync(temporaryDirectory).some((entry) => entry.includes("translation."))).toBe(false);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("subtitle source identity rejects same-metadata content replacement", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-source-identity-replaced-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const taskId = "88888888-8888-4888-8888-888888888888";
  const checkpointPath = path.join(
    temporaryDirectory,
    `movie.translation.${taskId.replaceAll("-", "")}.json`
  );
  const currentSource =
    "1\n00:00:00,000 --> 00:00:01,000\nCurrent A\n\n" +
    "2\n00:00:01,000 --> 00:00:02,000\nCurrent B\n";
  writeFileSync(sourcePath, currentSource, "utf8");
  const fixedTime = new Date("2026-01-02T03:04:05.000Z");
  utimesSync(sourcePath, fixedTime, fixedTime);
  const sourceInfo = statSync(sourcePath);
  const prompt = "Translate every cue to {{lang}}. {{additional}}";
  const streamBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      if (JSON.parse(bodyText).stream === true) streamBodies.push(bodyText);
    },
    getStreamElements: (bodyText) => {
      const count = Number(
        bodyText.match(/exactly (\d+) translated strings/i)?.[1] ?? 1
      );
      return Array.from({ length: count }, (_, index) => `Fresh ${index + 1}`);
    },
  });
  const configFingerprint = createTestTranslationConfigFingerprint({
    apiHost: mockServer.apiHost,
    model: "test-model",
    prompt,
    lang: "English",
    additional: "",
    temperature: 1,
    contextSize: 5,
  });
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      version: 3,
      format: "srt",
      source: {
        name: "movie.srt",
        fingerprint: { size: sourceInfo.size, mtimeMs: sourceInfo.mtimeMs },
      },
      translation: { configFingerprint },
      task: { id: taskId },
      subtitle: [
        {
          type: "cue",
          data: {
            start: 0,
            end: 1_000,
            text: "Former A",
            translatedText: "Stale A",
          },
        },
        {
          type: "cue",
          data: {
            start: 1_000,
            end: 2_000,
            text: "Former B",
            translatedText: "Stale B",
          },
        },
      ],
    }),
    "utf8"
  );

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    await page.evaluate(
      async ({ sourcePath, taskId, apiHost, prompt }) => {
        await window.electronAPI.translateBatch({
          files: [{ taskId, path: sourcePath, name: "movie.srt" }],
          params: {
            apiKeys: ["test-key"], apiHost, model: "test-model", prompt,
            lang: "English", additional: "", temperature: 1,
            outputFormat: "srt-translation",
            assFonts: { translationFont: "", originalFont: "" },
            concurrency: 1, delay: 0, requestsPerMinute: 1_000, contextSize: 5,
          },
        });
      },
      { sourcePath, taskId, apiHost: mockServer.apiHost, prompt }
    );

    expect(streamBodies).toHaveLength(1);
    expect(streamBodies[0]).toContain("Current A");
    expect(streamBodies[0]).toContain("Current B");
    expect(streamBodies[0]).not.toContain("Former A");
    const output = readFileSync(
      path.join(temporaryDirectory, "movie.en.srt"),
      "utf8"
    );
    expect(output).toContain("Fresh 1");
    expect(output).toContain("Fresh 2");
    expect(output).not.toContain("Stale A");
    expect(readdirSync(temporaryDirectory).some((entry) => entry.includes("translation."))).toBe(false);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("subtitle source identity rejects an ASS style replacement", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-source-identity-ass-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.ass");
  const taskId = "99999999-9999-4999-8999-999999999999";
  const checkpointPath = path.join(
    temporaryDirectory,
    `movie.translation.${taskId.replaceAll("-", "")}.json`
  );
  const currentSource = createAssSource("Noto Sans", "Hello from ASS");
  const previousSource = createAssSource("Arial", "Hello from ASS");
  writeFileSync(sourcePath, currentSource, "utf8");
  const sourceInfo = statSync(sourcePath);
  const prompt = "Translate every cue to {{lang}}. {{additional}}";
  const streamBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => {
      if (JSON.parse(bodyText).stream === true) streamBodies.push(bodyText);
    },
    getStreamElements: () => ["Fresh ASS translation"],
  });
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      version: 3,
      format: "ass",
      source: {
        name: "movie.ass",
        fingerprint: { size: sourceInfo.size, mtimeMs: sourceInfo.mtimeMs },
      },
      translation: {
        configFingerprint: createTestTranslationConfigFingerprint({
          apiHost: mockServer.apiHost,
          model: "test-model",
          prompt,
          lang: "English",
          additional: "",
          temperature: 1,
          contextSize: 5,
        }),
      },
      task: { id: taskId },
      subtitle: createAssCheckpointSubtitle(previousSource, "Stale ASS translation"),
    }),
    "utf8"
  );

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    await page.evaluate(
      async ({ sourcePath, taskId, apiHost, prompt }) => {
        await window.electronAPI.translateBatch({
          files: [{ taskId, path: sourcePath, name: "movie.ass" }],
          params: {
            apiKeys: ["test-key"], apiHost, model: "test-model", prompt,
            lang: "English", additional: "", temperature: 1,
            outputFormat: "ass-bilingual",
            assFonts: { translationFont: "", originalFont: "" },
            concurrency: 1, delay: 0, requestsPerMinute: 1_000, contextSize: 5,
          },
        });
      },
      { sourcePath, taskId, apiHost: mockServer.apiHost, prompt }
    );

    expect(streamBodies).toHaveLength(1);
    expect(streamBodies[0]).toContain("Hello from ASS");
    const outputName = readdirSync(temporaryDirectory).find(
      (entry) => entry !== "movie.ass" && entry.endsWith(".ass")
    );
    expect(outputName).toBeTruthy();
    const output = readFileSync(
      path.join(temporaryDirectory, outputName!),
      "utf8"
    );
    expect(output).toContain("Fresh ASS translation");
    expect(output).not.toContain("Stale ASS translation");
    expect(readdirSync(temporaryDirectory).some((entry) => entry.includes("translation."))).toBe(false);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the real GUI translates a confidently detected legacy-encoded subtitle", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-legacy-encoding-")
  );
  const sourcePath = path.join(temporaryDirectory, "movie.srt");
  const sourceSentence =
    "简体中文字幕测试，这是一段用于识别编码并验证翻译内容的长文本。";
  const sourceText = Array.from({ length: 20 }, (_, index) => {
    const start = String(index).padStart(2, "0");
    const end = String(index + 1).padStart(2, "0");
    return `${index + 1}\n00:00:${start},000 --> 00:00:${end},000\n${sourceSentence}\n`;
  }).join("\n");
  writeFileSync(sourcePath, iconv.encode(sourceText, "gb18030"));

  const requestBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => requestBodies.push(bodyText),
    getStreamElements: (bodyText) => {
      const count = Number(
        bodyText.match(/exactly (\d+) translated strings/i)?.[1] ?? 1
      );
      return Array.from(
        { length: count },
        (_, index) => `Correct translation ${index + 1}`
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
        localStorage.setItem(
          "prompt",
          JSON.stringify("Translate every cue to {{lang}}. {{additional}}")
        );
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

    await page.locator('input[type="file"]').setInputFiles(sourcePath);
    const taskDialog = page.getByRole("dialog");
    await expect(taskDialog).toBeVisible();
    await taskDialog.getByRole("button", { name: "Add task" }).click();

    const taskRow = page.getByRole("row").filter({ hasText: "movie.srt" });
    await expect(taskRow.getByText("Completed", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    expect(requestBodies.join("\n")).toContain(sourceSentence);
    expect(requestBodies.join("\n")).not.toContain("�");
    const outputBytes = readFileSync(
      path.join(temporaryDirectory, "movie.en.srt")
    );
    const output = new TextDecoder("utf-8", { fatal: true }).decode(
      outputBytes
    );
    expect(output).toContain("Correct translation");
    expect(output).not.toContain("�");
    expect(
      readdirSync(temporaryDirectory).filter(
        (name) =>
          name.includes(".translation.") || name.endsWith(".backup.json")
      )
    ).toEqual([]);
  } finally {
    await app?.close();
    await mockServer.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the real GUI explains an unsupported encoding before API or file writes", async () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "subtitle-translator-encoding-failure-")
  );
  const sourcePath = path.join(temporaryDirectory, "ambiguous.srt");
  const outputPath = path.join(temporaryDirectory, "ambiguous.en.srt");
  writeFileSync(
    sourcePath,
    Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00])
  );
  writeFileSync(outputPath, "sentinel", "utf8");

  const requestBodies: string[] = [];
  const mockServer = await startMockOpenAiServer({
    onRequest: ({ bodyText }) => requestBodies.push(bodyText),
  });

  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [".", "--no-sandbox"] });
    const page = await app.firstWindow();
    await page.evaluate(
      ({ apiHost }) => {
        localStorage.clear();
        localStorage.setItem("language", JSON.stringify("zh-CN"));
        localStorage.setItem("api_keys", JSON.stringify(["test-key"]));
        localStorage.setItem("api_host", JSON.stringify(apiHost));
        localStorage.setItem("model", JSON.stringify("test-model"));
        localStorage.setItem(
          "prompt",
          JSON.stringify("Translate every cue to {{lang}}. {{additional}}")
        );
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

    await page.locator('input[type="file"]').setInputFiles(sourcePath);
    const taskDialog = page.getByRole("dialog");
    await expect(taskDialog).toBeVisible();
    await taskDialog.getByRole("button", { name: "新增任务" }).click();

    const taskRow = page
      .getByRole("row")
      .filter({ hasText: "ambiguous.srt" });
    await expect(taskRow.getByText("失败", { exact: true })).toBeVisible();
    await taskRow
      .getByRole("button", { name: "查看 ambiguous.srt 翻译详情" })
      .click();
    await expect(page.getByRole("heading", { name: "错误详细信息" })).toBeVisible();
    await expect(page.locator("pre")).toContainText(
      "无法可靠识别该字幕的文本编码。请使用记事本、Notepad++ 等工具将字幕转换为 UTF-8 编码后重试。"
    );

    expect(requestBodies).toHaveLength(0);
    expect(readFileSync(outputPath, "utf8")).toBe("sentinel");
    expect(
      readdirSync(temporaryDirectory).filter(
        (name) =>
          name.includes(".translation.") || name.endsWith(".backup.json")
      )
    ).toEqual([]);
  } finally {
    await app?.close();
    await mockServer.close();
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
