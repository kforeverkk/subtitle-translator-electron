import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test.describe.configure({ mode: "serial" });

test("homepage has title and links to intro page", async () => {
  const app = await electron.launch({ args: [".", "--no-sandbox"] });
  try {
    const page = await app.firstWindow();
    expect(await page.title()).toBe("Subtitle translator");
    await page.screenshot({ path: "e2e/screenshots/example.png" });
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

      const sendCompletedTranslations = (filePaths: string[]) =>
        app.evaluate(({ BrowserWindow }, completedPaths) => {
          const mainWindow = BrowserWindow.getAllWindows().find(
            (window) => !window.isDestroyed()
          );
          if (!mainWindow) throw new Error("Main window not found");

          for (const filePath of completedPaths) {
            mainWindow.webContents.send("batch-progress", {
              filePath,
              progress: 100,
              status: "done",
            });
          }
        }, filePaths);
      const readSuccessCount = () =>
        page.evaluate(() =>
          JSON.parse(
            localStorage.getItem("translation_success_count") ?? "0"
          )
        );

      await sendCompletedTranslations([subtitlePath]);
      await expect.poll(readSuccessCount).toBe(20);
      await expect(taskRow).toBeVisible();
      await expect(coffeeBanner).toBeVisible();

      await coffeeBanner.getByRole("button", { name: "Close" }).click();
      await expect(coffeeBanner).not.toBeVisible();

      // A repeated completion event for the same attempt must not count twice.
      await sendCompletedTranslations([subtitlePath]);
      await expect.poll(readSuccessCount).toBe(20);
      await expect(coffeeBanner).not.toBeVisible();

      await sendCompletedTranslations(
        Array.from(
          { length: 19 },
          (_, index) => `completed-${index + 21}.srt`
        )
      );
      await expect.poll(readSuccessCount).toBe(39);
      await expect(coffeeBanner).not.toBeVisible();

      await sendCompletedTranslations(["completed-40.srt"]);
      await expect.poll(readSuccessCount).toBe(40);
      await expect(coffeeBanner).toBeVisible();
      await coffeeBanner.getByRole("button", { name: "Close" }).click();
      await expect(coffeeBanner).not.toBeVisible();

      await sendCompletedTranslations(
        Array.from(
          { length: 19 },
          (_, index) => `completed-${index + 41}.srt`
        )
      );
      await expect.poll(readSuccessCount).toBe(59);
      await expect(coffeeBanner).not.toBeVisible();

      // If React batches enough completions to cross 60 and 80 together,
      // both prompts must remain queued instead of collapsing into one.
      await sendCompletedTranslations(
        Array.from(
          { length: 21 },
          (_, index) => `completed-${index + 60}.srt`
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
