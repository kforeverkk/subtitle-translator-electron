import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
  type Session,
  type WebFrameMain,
  type WebContents,
} from "electron";
import { translationErrorCodes } from "../shared/translation-error-codes";
import { release } from "node:os";
import { join } from "node:path";
import fs, { type Stats } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pool from "tiny-async-pool";
import { z } from "zod";
import {
  type BatchProgress,
  type BatchTranslationRequest,
  type CheckpointSaveWarning,
} from "../../src/types/electron-api";
import {
  createTranslationCacheDocument,
  parseSubtitle,
  parseTranslationCache,
  readSubtitleSourceSnapshot,
  translateSubtitleChunk,
  serializeTranslatedSubtitle,
  analyzeSubtitlesForContext,
  detectSubtitleLanguage,
  getSubtitleCues,
  validateSubtitleOutputCompatibility,
} from "./utils/translate";
import {
  hasMatchingCheckpointSource,
  type CurrentSubtitleSourceIdentity,
} from "./utils/subtitle-source-identity";
import { createSubtitlePreview } from "./utils/subtitle-preview";
import { normalizeAssFontName } from "./utils/ass-bilingual";
import { subtitleOutputFormats } from "./utils/subtitle-output";
import {
  createTranslationOutputIdentity,
  getReusableTranslationOutputIdentity,
  getTranslatedPath,
  getTranslatedPathFromOutputIdentity,
} from "./utils/output-path";
import { getSubtitleAnalysisPlan } from "./utils/subtitle-sampling";
import { fetchAvailableModels } from "./utils/models";
import { getFirstValidApiKey } from "./utils/api-account";
import {
  RequestRateLimiterRegistry,
  type RequestRateLimiterLease,
} from "./utils/request-rate-limiter-registry";
import { isAllowedApiHost } from "./utils/api-host";
import {
  getErrorMessage,
  retryTranslation,
} from "./utils/translation-retry";
import {
  clearSubtitleCueTranslations,
  isSubtitleCueComplete,
  splitIntoChunk,
} from "./utils/subtitle-chunks";
import {
  getPathClaimKey,
  hasPathClaimConflict,
} from "./utils/path-claims";
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
  type TranslationSourceFingerprint,
} from "./utils/translation-checkpoint";
import {
  createSubtitleOutputWriter,
  writeFinalSubtitleOutput,
} from "./utils/subtitle-file-writer";
import type {
  ParsedSubtitle,
  SubtitleCue,
  SubtitleFileExtension,
  TranslationCacheDocument,
} from "./utils/translate";

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.js    > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.DIST_ELECTRON = join(__dirname, "../");
process.env.DIST = join(process.env.DIST_ELECTRON, "../dist");
process.env.PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? join(process.env.DIST_ELECTRON, "../public")
  : process.env.DIST;

// Keep Electron E2E runs independent from an installed copy of the app. This
// must happen before requestSingleInstanceLock(), because Electron scopes that
// lock to the user-data directory. Production launches never set this value.
const e2eUserDataPath = process.env.SUBTITLE_TRANSLATOR_E2E_USER_DATA;
if (e2eUserDataPath) app.setPath("userData", e2eUserDataPath);

// Disable GPU Acceleration for Windows 7
if (release().startsWith("6.1")) app.disableHardwareAcceleration();

// Set application name for Windows 10+ notifications
if (process.platform === "win32") app.setAppUserModelId(app.getName());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Remove electron security warnings
// This warning only shows in development mode
// Read more on https://www.electronjs.org/docs/latest/tutorial/security
// process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

let win: BrowserWindow | null = null;
let aboutWindow: BrowserWindow | null = null;
// Here, you can also use other preload
const preload = join(__dirname, "../preload/index.js");
const url = process.env.VITE_DEV_SERVER_URL;
const indexHtml = join(process.env.DIST, "index.html");
const packagedIndexUrl = pathToFileURL(indexHtml).href;
const supportedExtensions = new Set<SubtitleFileExtension>([
  "ass",
  "ssa",
  "srt",
  "vtt",
]);
const supportedInputExtensions = new Set<string>([
  ...supportedExtensions,
  "json",
]);
const allowedExternalHosts = new Set([
  "github.com",
  "www.github.com",
  "www.buymeacoffee.com",
]);
const MIN_CUES_FOR_CONTEXT_ANALYSIS = 20;
const DEFAULT_CONTEXT_SIZE = 5;
const applicationLocaleSchema = z.enum(["en-US", "zh-TW", "zh-CN"]);
type ApplicationLocale = z.infer<typeof applicationLocaleSchema>;
let applicationLocale: ApplicationLocale | undefined;
const activeTranslationPathClaims = new Set<string>();
const activeTranslationControllers = new Map<string, Set<AbortController>>();
const requestRateLimiterRegistry = new RequestRateLimiterRegistry();

const subtitleFileSchema = z
  .object({
    taskId: z.string().refine(isTranslationTaskId, {
      message: "Invalid translation task ID",
    }),
    path: z.string().min(1),
    name: z.string().min(1),
  })
  .refine(({ path: filePath }) => isSupportedInputPath(filePath), {
    message: "Unsupported translation input file",
  });

const translationParamsSchema = z.object({
  apiKeys: z
    .array(z.string())
    .refine((keys) => keys.some((key) => key.trim().length > 0), {
      message: "At least one API key is required",
    }),
  apiHost: z.string().trim().min(1).refine(isAllowedApiHost, {
    message: "API host must use HTTPS unless it is a local server",
  }),
  model: z.string().min(1),
  prompt: z.string(),
  lang: z.string(),
  additional: z.string(),
  temperature: z.number().finite().min(0).max(2),
  outputFormat: z.enum(subtitleOutputFormats),
  assFonts: z
    .object({
      translationFont: z.string().max(100).transform(normalizeAssFontName),
      originalFont: z.string().max(100).transform(normalizeAssFontName),
    })
    .default({ translationFont: "", originalFont: "" }),
  concurrency: z
    .union([
      z.literal(1),
      z.literal(2),
      z.literal(5),
      z.literal(10),
    ])
    .default(10),
  delay: z.number().finite().min(0),
  requestsPerMinute: z
    .number()
    .finite()
    .safe()
    .int()
    .min(1)
    .max(100_000)
    .default(60),
  outputDirectory: z.string().optional(),
  contextSize: z.number().int().min(0).max(100).optional(),
});

const batchTranslationRequestSchema = z.object({
  files: z
    .array(subtitleFileSchema)
    .min(1)
    .max(100)
    .refine(
      (files) => new Set(files.map((file) => file.taskId)).size === files.length,
      { message: "Translation task IDs must be unique" }
    ),
  params: translationParamsSchema,
});

const subtitlePreviewRequestSchema = z.object({
  taskId: z.string().refine(isTranslationTaskId, {
    message: "Invalid translation task ID",
  }),
  filePath: z.string().min(1),
  outputPath: z
    .string()
    .min(1)
    .refine(path.isAbsolute, { message: "Output path must be absolute" })
    .optional(),
});

function isSupportedInputPath(filePath: string): boolean {
  return supportedInputExtensions.has(
    path.extname(filePath).slice(1).toLowerCase()
  );
}

function assertTranslationInputFile(filePath: string): Stats {
  if (!isSupportedInputPath(filePath)) {
    throw new Error(translationErrorCodes.unsupportedInputFile);
  }

  const fileInfo = fs.statSync(filePath);
  if (!fileInfo.isFile()) {
    throw new Error(translationErrorCodes.inputPathNotFile);
  }

  return fileInfo;
}

function isTrustedApplicationUrl(frameUrl: string): boolean {
  try {
    if (url) {
      return new URL(frameUrl).origin === new URL(url).origin;
    }

    const actualUrl = new URL(frameUrl);
    const expectedUrl = new URL(packagedIndexUrl);
    return (
      actualUrl.protocol === expectedUrl.protocol &&
      actualUrl.pathname === expectedUrl.pathname
    );
  } catch {
    return false;
  }
}

function isTrustedSender(frame: WebFrameMain | null): boolean {
  return frame !== null && isTrustedApplicationUrl(frame.url);
}

function assertTrustedSender(event: { senderFrame: WebFrameMain | null }): void {
  if (!isTrustedSender(event.senderFrame)) {
    throw new Error("Untrusted IPC sender");
  }
}

function registerTranslationController(
  taskId: string,
  controller: AbortController
): () => void {
  const controllers = activeTranslationControllers.get(taskId) || new Set();
  controllers.add(controller);
  activeTranslationControllers.set(taskId, controllers);

  return () => {
    controllers.delete(controller);
    if (controllers.size === 0) {
      activeTranslationControllers.delete(taskId);
    }
  };
}

function cancelTranslation(taskId: string): void {
  for (const controller of activeTranslationControllers.get(taskId) || []) {
    controller.abort();
  }
}

function isAllowedExternalUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.protocol === "https:" && allowedExternalHosts.has(parsed.hostname);
  } catch {
    return false;
  }
}

function getValidatedOutputDirectory(
  outputDirectory?: string
): string | undefined {
  if (!outputDirectory) return undefined;
  if (!path.isAbsolute(outputDirectory)) {
    throw new Error("Output directory must be an absolute path");
  }

  const directoryInfo = fs.statSync(outputDirectory);
  if (!directoryInfo.isDirectory()) {
    throw new Error("Output path is not a directory");
  }

  return outputDirectory;
}

function claimTranslationPaths(
  pathsToClaim: readonly string[],
  batchPathClaims: Set<string>
): () => void {
  const keys = pathsToClaim.map((filePath) => {
    const canonicalDirectory = fs.realpathSync.native(path.dirname(filePath));
    return getPathClaimKey(
      path.join(canonicalDirectory, path.basename(filePath))
    );
  });
  if (
    hasPathClaimConflict(
      keys,
      batchPathClaims,
      activeTranslationPathClaims
    )
  ) {
    throw new Error(translationErrorCodes.outputPathConflict);
  }

  for (const key of keys) {
    batchPathClaims.add(key);
    activeTranslationPathClaims.add(key);
  }
  return () => {
    for (const key of keys) activeTranslationPathClaims.delete(key);
  };
}

interface TranslationInput {
  parsed: ParsedSubtitle;
  sourceName: string;
  sourceExtension: SubtitleFileExtension;
  analysis?: string;
  cacheDocument?: TranslationCacheDocument;
  sourceFingerprint?: TranslationSourceFingerprint;
  checkpointPath: string;
  checkpointSourcePath?: string;
  shouldPreserveCheckpointSource: boolean;
  shouldClaimCheckpointSource: boolean;
  shouldRestartTranslation: boolean;
  backupOwnerTaskIds: string[];
}

function readCheckpoint(
  checkpointPath: string
): TranslationCacheDocument | undefined {
  try {
    return parseTranslationCache(fs.readFileSync(checkpointPath, "utf8"));
  } catch (error: unknown) {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (errorCode !== "ENOENT") {
      console.warn(
        `Ignoring an invalid translation checkpoint: ${checkpointPath}`,
        error
      );
    }
    return undefined;
  }
}

function readMatchingCheckpoint(
  checkpointPath: string,
  sourceIdentity: CurrentSubtitleSourceIdentity,
  expectedTaskId?: string
): TranslationCacheDocument | undefined {
  const checkpoint = readCheckpoint(checkpointPath);
  return checkpoint &&
    hasMatchingCheckpointSource(checkpoint, sourceIdentity) &&
    (!expectedTaskId || hasMatchingTranslationTask(checkpoint, expectedTaskId))
    ? checkpoint
    : undefined;
}

function findMatchingTaskCheckpoint(
  filePath: string,
  sourceName: string,
  sourceIdentity: CurrentSubtitleSourceIdentity,
  configFingerprint: string,
  targetCheckpointPath: string
): { path: string; checkpoint: TranslationCacheDocument } | undefined {
  let directoryEntries: string[];
  try {
    directoryEntries = fs.readdirSync(path.dirname(filePath));
  } catch {
    return undefined;
  }

  const candidates = getDiscoveredTaskTranslationCheckpointPaths(
    filePath,
    directoryEntries,
    sourceName
  )
    .filter((candidate) => candidate !== targetCheckpointPath)
    .flatMap((candidate) => {
      try {
        return [{ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates) {
    const checkpoint = readMatchingCheckpoint(
      candidate.path,
      sourceIdentity
    );
    if (
      checkpoint?.version === 3 &&
      hasMatchingTranslationConfig(checkpoint, configFingerprint)
    ) {
      return { path: candidate.path, checkpoint };
    }
  }
  return undefined;
}

function readTranslationInput(
  filePath: string,
  taskId: string,
  configFingerprint?: string
): TranslationInput {
  const fileInfo = assertTranslationInputFile(filePath);
  const extension = path.extname(filePath).slice(1).toLowerCase();

  if (extension === "json") {
    const cacheDocument = parseTranslationCache(
      fs.readFileSync(filePath, "utf8")
    );
    const resumeMetadata = getTranslationCheckpointResumeMetadata(
      cacheDocument,
      configFingerprint
    );
    const previousTaskId = cacheDocument.task?.id;

    return {
      parsed: cacheDocument.subtitle,
      sourceName: path.basename(cacheDocument.source.name),
      sourceExtension: cacheDocument.format,
      analysis: resumeMetadata.analysis,
      cacheDocument,
      sourceFingerprint: cacheDocument.source.fingerprint,
      checkpointPath: filePath,
      checkpointSourcePath: filePath,
      shouldPreserveCheckpointSource: resumeMetadata.shouldBackupCheckpoint,
      shouldClaimCheckpointSource: true,
      shouldRestartTranslation: resumeMetadata.shouldRestartTranslation,
      backupOwnerTaskIds: [taskId, previousTaskId].filter(
        (value): value is string => isTranslationTaskId(value)
      ),
    };
  }

  if (!supportedExtensions.has(extension as SubtitleFileExtension)) {
    throw new Error(translationErrorCodes.unsupportedSubtitleFormat);
  }

  const sourceName = path.basename(filePath);
  const sourceExtension = extension as SubtitleFileExtension;
  const sourceSnapshot = readSubtitleSourceSnapshot(
    filePath,
    sourceExtension,
    { size: fileInfo.size, mtimeMs: fileInfo.mtimeMs }
  );
  const sourceFingerprint = sourceSnapshot.fingerprint;
  const sourceIdentity: CurrentSubtitleSourceIdentity = {
    sourceName,
    format: sourceExtension,
    fingerprint: sourceFingerprint,
  };
  const checkpointPath = getTaskTranslationCheckpointPath(
    filePath,
    taskId,
    sourceName
  );
  const exactCheckpointExists = fs.existsSync(checkpointPath);
  const exactCheckpoint = readMatchingCheckpoint(
    checkpointPath,
    sourceIdentity,
    taskId
  );
  if (exactCheckpoint) {
    const resumeMetadata = getTranslationCheckpointResumeMetadata(
      exactCheckpoint,
      configFingerprint
    );
    return {
      parsed: exactCheckpoint.subtitle,
      sourceName,
      sourceExtension,
      analysis: resumeMetadata.analysis,
      cacheDocument: exactCheckpoint,
      sourceFingerprint,
      checkpointPath,
      checkpointSourcePath: checkpointPath,
      shouldPreserveCheckpointSource: resumeMetadata.shouldBackupCheckpoint,
      shouldClaimCheckpointSource: true,
      shouldRestartTranslation: resumeMetadata.shouldRestartTranslation,
      backupOwnerTaskIds: [taskId],
    };
  }

  if (exactCheckpointExists) {
    return {
      parsed: sourceSnapshot.parsed,
      sourceName,
      sourceExtension,
      sourceFingerprint,
      checkpointPath,
      checkpointSourcePath: checkpointPath,
      shouldPreserveCheckpointSource: true,
      shouldClaimCheckpointSource: true,
      shouldRestartTranslation: false,
      backupOwnerTaskIds: [taskId],
    };
  }

  let selectedCheckpoint:
    | { path: string; checkpoint: TranslationCacheDocument }
    | undefined;
  let incompatibleLegacyPath: string | undefined;
  for (const legacyPath of getTranslationCheckpointCandidates(
    filePath,
    sourceName
  )) {
    const candidateCheckpoint = readCheckpoint(legacyPath);
    if (!candidateCheckpoint) continue;
    const checkpoint = hasMatchingCheckpointSource(
      candidateCheckpoint,
      sourceIdentity
    )
      ? candidateCheckpoint
      : undefined;
    if (!checkpoint) {
      incompatibleLegacyPath ??= legacyPath;
      continue;
    }
    const resumeMetadata = checkpoint
      ? getTranslationCheckpointResumeMetadata(checkpoint, configFingerprint)
      : undefined;
    if (
      checkpoint?.version === 1 &&
      configFingerprint &&
      resumeMetadata?.shouldRestartTranslation
    ) {
      incompatibleLegacyPath ??= legacyPath;
      continue;
    }
    if (checkpoint && !resumeMetadata?.shouldRestartTranslation) {
      selectedCheckpoint = { path: legacyPath, checkpoint };
      break;
    }
  }
  if (!selectedCheckpoint && configFingerprint) {
    selectedCheckpoint = findMatchingTaskCheckpoint(
      filePath,
      sourceName,
      sourceIdentity,
      configFingerprint,
      checkpointPath
    );
  }

  if (selectedCheckpoint) {
    const resumeMetadata = getTranslationCheckpointResumeMetadata(
      selectedCheckpoint.checkpoint,
      configFingerprint
    );
    const previousTaskId = selectedCheckpoint.checkpoint.task?.id;
    return {
      parsed: selectedCheckpoint.checkpoint.subtitle,
      sourceName,
      sourceExtension,
      analysis: resumeMetadata.analysis,
      cacheDocument: selectedCheckpoint.checkpoint,
      sourceFingerprint,
      checkpointPath,
      checkpointSourcePath: selectedCheckpoint.path,
      shouldPreserveCheckpointSource: true,
      shouldClaimCheckpointSource: true,
      shouldRestartTranslation: resumeMetadata.shouldRestartTranslation,
      backupOwnerTaskIds: [taskId, previousTaskId].filter(
        (value): value is string => isTranslationTaskId(value)
      ),
    };
  }

  if (incompatibleLegacyPath) {
    return {
      // This legacy checkpoint cannot prove that its cues still belong to the
      // current source. Start from the current subtitle and archive the legacy
      // file only after the replacement v3 checkpoint is durable.
      parsed: sourceSnapshot.parsed,
      sourceName,
      sourceExtension,
      sourceFingerprint,
      checkpointPath,
      checkpointSourcePath: incompatibleLegacyPath,
      shouldPreserveCheckpointSource: true,
      // Multiple new-language tasks may see the same shared legacy file. They
      // may race to archive it after their own v3 commit; ENOENT is safe.
      shouldClaimCheckpointSource: false,
      shouldRestartTranslation: false,
      backupOwnerTaskIds: [taskId],
    };
  }

  return {
    parsed: sourceSnapshot.parsed,
    sourceName,
    sourceExtension,
    sourceFingerprint,
    checkpointPath,
    shouldPreserveCheckpointSource: false,
    shouldClaimCheckpointSource: false,
    shouldRestartTranslation: false,
    backupOwnerTaskIds: [taskId],
  };
}

function sendProgress(sender: WebContents, progress: BatchProgress): void {
  sender.send("batch-progress", progress);
}

function sendCheckpointSaveWarning(
  sender: WebContents,
  warning: CheckpointSaveWarning
): void {
  if (sender.isDestroyed()) return;

  try {
    sender.send("checkpoint-save-warning", warning);
  } catch (error: unknown) {
    console.warn("Failed to send checkpoint save warning:", error);
  }
}

function getApplicationLocale(): ApplicationLocale {
  if (applicationLocale) return applicationLocale;

  const parsedLocale = applicationLocaleSchema.safeParse(app.getLocale());
  applicationLocale = parsedLocale.success ? parsedLocale.data : "en-US";
  return applicationLocale;
}

function getAboutLabel(): string {
  switch (getApplicationLocale()) {
    case "zh-TW":
      return "關於 Subtitle Translator";
    case "zh-CN":
      return "关于 Subtitle Translator";
    default:
      return "About Subtitle Translator";
  }
}

function getHelpLabel(): string {
  switch (getApplicationLocale()) {
    case "zh-TW":
      return "說明";
    case "zh-CN":
      return "帮助";
    default:
      return "Help";
  }
}

function setApplicationLocale(locale: unknown): void {
  const nextLocale = applicationLocaleSchema.parse(locale);
  if (applicationLocale === nextLocale) return;

  applicationLocale = nextLocale;
  createApplicationMenu();
}

function loadRenderer(browserWindow: BrowserWindow, hash?: string): void {
  if (url) {
    void browserWindow.loadURL(hash ? `${url}#${hash}` : url);
  } else if (hash) {
    void browserWindow.loadFile(indexHtml, { hash });
  } else {
    void browserWindow.loadFile(indexHtml);
  }
}

function configureWindowNavigation(browserWindow: BrowserWindow): void {
  browserWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isAllowedExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    }
    return { action: "deny" };
  });

  browserWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    let isAllowed = false;
    try {
      if (url) {
        isAllowed =
          new URL(navigationUrl).origin === new URL(url).origin;
      } else {
        const actualUrl = new URL(navigationUrl);
        const expectedUrl = new URL(packagedIndexUrl);
        isAllowed =
          actualUrl.protocol === expectedUrl.protocol &&
          actualUrl.pathname === expectedUrl.pathname;
      }
    } catch {
      isAllowed = false;
    }

    if (!isAllowed) event.preventDefault();
  });
}

function createAboutWindow(parentWindow: BrowserWindow): void {
  const nextAboutWindow = new BrowserWindow({
    parent: parentWindow,
    title: getAboutLabel(),
    icon: join(process.env.PUBLIC, "favicon.ico"),
    width: 600,
    height: 720,
    resizable: false,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "default",
        }
      : {
          titleBarOverlay: true,
          autoHideMenuBar: true,
          backgroundMaterial: "mica",
        }),
  });

  aboutWindow = nextAboutWindow;
  nextAboutWindow.on("closed", () => {
    if (aboutWindow === nextAboutWindow) aboutWindow = null;
  });

  configureWindowNavigation(nextAboutWindow);
  loadRenderer(nextAboutWindow, "/about");
  nextAboutWindow.once("ready-to-show", () => nextAboutWindow.show());
}

function openAboutWindow(): void {
  const mainWindow = showOrCreateMainWindow();
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    if (aboutWindow.getParentWindow() === mainWindow) {
      if (aboutWindow.isMinimized()) aboutWindow.restore();
      aboutWindow.focus();
      return;
    }

    aboutWindow.close();
    aboutWindow = null;
  }

  createAboutWindow(mainWindow);
}

function createApplicationMenu(): void {
  const aboutLabel = getAboutLabel();
  const helpLabel = getHelpLabel();
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.getName(),
      submenu: [
        { label: aboutLabel, click: openAboutWindow },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  );

  if (process.platform !== "darwin") {
    template.push({
      label: helpLabel,
      submenu: [{ label: aboutLabel, click: openAboutWindow }],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function configureSessionPermissions(applicationSession: Session): void {
  const isTrustedLocalFontsRequest = (
    permission: string,
    requestingUrl: string | undefined
  ) =>
    permission === "local-fonts" &&
    typeof requestingUrl === "string" &&
    isTrustedApplicationUrl(requestingUrl);

  applicationSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      isTrustedLocalFontsRequest(
        permission,
        details.requestingUrl || webContents?.getURL() || requestingOrigin
      )
  );
  applicationSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        isTrustedLocalFontsRequest(
          permission,
          details.requestingUrl || webContents.getURL()
        )
      );
    }
  );
}

function createWindow(): BrowserWindow {
  const nextWindow = new BrowserWindow({
    title: "Main window",
    icon: join(process.env.PUBLIC, "favicon.ico"),
    minWidth: 800,
    minHeight: 640,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...(process.platform === "darwin"
      ? {
          vibrancy: "fullscreen-ui",
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 10, y: 20 },
        }
      : {
          titleBarOverlay: true,
          autoHideMenuBar: true, // on Windows 11
          backgroundMaterial: "mica", // on Windows 11
        }),
  });
  win = nextWindow;

  configureSessionPermissions(nextWindow.webContents.session);

  loadRenderer(nextWindow);
  // Open devTool if the app is not packaged
  // win.webContents.openDevTools()
  configureWindowNavigation(nextWindow);

  nextWindow.on("closed", () => {
    if (win !== nextWindow) return;

    win = null;
    if (aboutWindow && !aboutWindow.isDestroyed()) {
      aboutWindow.close();
    }
  });

  return nextWindow;
}

function showOrCreateMainWindow(): BrowserWindow {
  if (!win || win.isDestroyed()) {
    win = null;
    return createWindow();
  }

  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return win;
}

app.whenReady()
  .then(() => {
    createApplicationMenu();
    createWindow();
  })
  .catch((error: unknown) => {
    console.error("Failed to create application window:", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  showOrCreateMainWindow();
});

app.on("activate", () => {
  showOrCreateMainWindow();
});

// Cache analysis per file so renderer can fetch it on demand
const analysisCache = new Map<string, string>();

ipcMain.handle("set-menu-locale", (event, locale: unknown) => {
  assertTrustedSender(event);
  setApplicationLocale(locale);
});

ipcMain.handle("open-external", (event, target: unknown) => {
  assertTrustedSender(event);

  if (typeof target !== "string" || !isAllowedExternalUrl(target)) {
    throw new Error("External URL is not allowed");
  }

  return shell.openExternal(target);
});

ipcMain.handle("select-directory", async (event, defaultPath: unknown) => {
  assertTrustedSender(event);

  const validatedDefaultPath = z.string().min(1).optional().parse(defaultPath);
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    ...(validatedDefaultPath ? { defaultPath: validatedDefaultPath } : {}),
  });

  return canceled ? null : filePaths[0] ?? null;
});

ipcMain.handle("list-models", async (event, request: unknown) => {
  assertTrustedSender(event);

  const { apiKey, apiHost } = z
    .object({
      apiKey: z.string().min(1),
      apiHost: z.string().trim().min(1).refine(isAllowedApiHost, {
        message: "API host must use HTTPS unless it is a local server",
      }),
    })
    .parse(request);

  return fetchAvailableModels({ apiKey, apiHost });
});

ipcMain.on("cancel-translation", (event, taskId: unknown) => {
  if (!isTrustedSender(event.senderFrame)) return;
  if (!isTranslationTaskId(taskId)) return;
  cancelTranslation(taskId);
});

ipcMain.handle("batch-translate", async (event, request: unknown) => {
  assertTrustedSender(event);
  const { files, params } = batchTranslationRequestSchema.parse(request);
  const translationConfigFingerprint = createTranslationConfigFingerprint({
    apiHost: params.apiHost,
    model: params.model,
    prompt: params.prompt,
    lang: params.lang,
    additional: params.additional,
    temperature: params.temperature,
    contextSize: params.contextSize ?? DEFAULT_CONTEXT_SIZE,
  });
  if (
    files.some((file) => activeTranslationControllers.has(file.taskId))
  ) {
    throw new Error("Translation task ID is already active");
  }
  const translationControllersByTaskId = new Map<string, AbortController>();
  const unregisterTranslationControllers: Array<() => void> = [];
  for (const file of files) {
    const controller = new AbortController();
    translationControllersByTaskId.set(file.taskId, controller);
    unregisterTranslationControllers.push(
      registerTranslationController(file.taskId, controller)
    );
  }
  let requestRateLimiterLease: RequestRateLimiterLease;
  try {
    requestRateLimiterLease = requestRateLimiterRegistry.acquire({
      apiHost: params.apiHost,
      apiKey: getFirstValidApiKey(params.apiKeys),
      requestsPerMinute: params.requestsPerMinute,
      minimumIntervalMs: params.delay,
    });
  } catch (error: unknown) {
    for (const unregister of unregisterTranslationControllers) unregister();
    throw error;
  }
  const requestRateLimiter = requestRateLimiterLease.limiter;
  // Keep these claims for the whole request so later files cannot silently
  // overwrite an earlier file after its active write lock has been released.
  const batchPathClaims = new Set<string>();
  const processFile = async (file: BatchTranslationRequest["files"][number]) => {
    const abortSignal = translationControllersByTaskId.get(file.taskId)?.signal;
    if (!abortSignal) return;
    let outputPath: string | undefined;
    let releasePathClaims: (() => void) | undefined;
    try {
      abortSignal.throwIfAborted();
      const input = readTranslationInput(
        file.path,
        file.taskId,
        translationConfigFingerprint
      );
      const parsed = input.parsed;
      const subtitle = getSubtitleCues(parsed);
      const totalCues = subtitle.length;
      const checkpointCompletedCues =
        subtitle.filter(isSubtitleCueComplete).length;
      const initialAnalysisPlan = getSubtitleAnalysisPlan(
        input.analysis,
        totalCues,
        checkpointCompletedCues,
        MIN_CUES_FOR_CONTEXT_ANALYSIS
      );
      const shouldRestartForMissingAnalysis =
        !input.shouldRestartTranslation &&
        initialAnalysisPlan.shouldRestartForMissingAnalysis;
      const shouldRestartTranslation =
        input.shouldRestartTranslation || shouldRestartForMissingAnalysis;
      if (shouldRestartTranslation) {
        clearSubtitleCueTranslations(subtitle);
      }
      validateSubtitleOutputCompatibility(
        parsed,
        input.sourceExtension,
        params.outputFormat,
        params.assFonts
      );
      let completedCues = subtitle.filter(isSubtitleCueComplete).length;

      // 建立原始索引對照，供後續「上下文視窗」策略使用
      const indexMap = new Map<SubtitleCue, number>();
      subtitle.forEach((cue, idx) => indexMap.set(cue, idx));

      const allTexts = subtitle
        .map((cue) => cue.data.text)
        .filter((text: string) => text && text.length > 0);
      let outputIdentity = getReusableTranslationOutputIdentity({
        cachedIdentity: input.cacheDocument?.output,
        outputFormat: params.outputFormat,
        shouldRestartTranslation: input.shouldRestartTranslation,
      });
      if (!outputIdentity) {
        let detectedSourceLanguage = "";
        try {
          detectedSourceLanguage = await retryTranslation(
            (texts) =>
              detectSubtitleLanguage(texts, {
                apiKeys: params.apiKeys,
                apiHost: params.apiHost,
                model: params.model,
                requestRateLimiter,
                abortSignal,
              }),
            allTexts,
            {
              delayMs: params.delay,
              abortSignal,
            }
          );
        } catch (languageDetectionError) {
          abortSignal.throwIfAborted();
          console.warn(
            "Source language detection failed; using the original fallback:",
            languageDetectionError
          );
        }
        outputIdentity = createTranslationOutputIdentity(
          file.path,
          params.outputFormat,
          input.sourceName,
          params.lang,
          detectedSourceLanguage
        );
      }

      const outputDirectory = getValidatedOutputDirectory(
        params.outputDirectory
      );
      const translatedOutputPath = getTranslatedPathFromOutputIdentity(
        file.path,
        outputDirectory,
        outputIdentity
      );
      outputPath = translatedOutputPath;
      const subtitleOutputWriter =
        createSubtitleOutputWriter(translatedOutputPath);
      let analysisData = shouldRestartTranslation
        ? undefined
        : input.analysis;
      analysisCache.delete(file.taskId);
      const checkpointPath = input.checkpointPath;
      const checkpointSourcePath = input.checkpointSourcePath;
      const ownedBackupPaths = new Set<string>();
      let pendingCheckpointSourcePath =
        input.shouldPreserveCheckpointSource ||
        shouldRestartForMissingAnalysis
          ? checkpointSourcePath
          : undefined;
      releasePathClaims = claimTranslationPaths(
        [...new Set([
          translatedOutputPath,
          checkpointPath,
          ...(pendingCheckpointSourcePath && input.shouldClaimCheckpointSource
            ? [pendingCheckpointSourcePath]
            : []),
        ])],
        batchPathClaims
      );
      if (pendingCheckpointSourcePath === checkpointPath) {
        abortSignal.throwIfAborted();
        const backupPath = await copyTranslationCheckpointBackup(
          checkpointPath,
          file.taskId
        );
        ownedBackupPaths.add(backupPath);
        pendingCheckpointSourcePath = undefined;
        console.warn(
          `Preserved an incompatible translation checkpoint at: ${backupPath}`
        );
      }
      const checkpointWriter = createCheckpointWriter(
        checkpointPath,
        () =>
          createTranslationCacheDocument({
            subtitle: parsed,
            sourceName: input.sourceName,
            format: input.sourceExtension,
            configFingerprint: translationConfigFingerprint,
            taskId: file.taskId,
            output: outputIdentity,
            analysis: analysisData,
            sourceFingerprint: input.sourceFingerprint,
          })
      );
      let checkpointWarningSent = false;
      const archiveMigratedCheckpoint = async () => {
        if (!pendingCheckpointSourcePath) return;
        try {
          const backupPath = await backupTranslationCheckpoint(
            pendingCheckpointSourcePath,
            file.taskId
          );
          ownedBackupPaths.add(backupPath);
          pendingCheckpointSourcePath = undefined;
          console.warn(
            `Migrated the previous translation checkpoint to: ${backupPath}`
          );
        } catch (error: unknown) {
          const errorCode =
            typeof error === "object" && error !== null && "code" in error
              ? error.code
              : undefined;
          if (errorCode === "ENOENT") {
            pendingCheckpointSourcePath = undefined;
            return;
          }
          // The new v3 checkpoint is already durable. Keeping the legacy file
          // is safe and lets a later save or successful cleanup retry removal.
          console.warn("Failed to archive migrated translation checkpoint:", error);
        }
      };
      const persistCheckpoint = async () => {
        try {
          await checkpointWriter.write();
        } catch (error: unknown) {
          console.warn("Failed to write translation checkpoint:", error);
          if (!checkpointWarningSent) {
            checkpointWarningSent = true;
            sendCheckpointSaveWarning(event.sender, {
              taskId: file.taskId,
              filePath: file.path,
            });
          }
          return false;
        }
        await archiveMigratedCheckpoint();
        return true;
      };
      const removeSuccessfulCheckpointArtifacts = async () => {
        let previousOwnedBackups: string[] = [];
        try {
          const checkpointDirectory = path.dirname(checkpointPath);
          previousOwnedBackups = getOwnedTranslationCheckpointBackupPaths(
            checkpointDirectory,
            fs.readdirSync(checkpointDirectory),
            input.backupOwnerTaskIds
          );
        } catch (error: unknown) {
          console.warn("Failed to discover owned checkpoint backups:", error);
        }
        await removeTranslationCheckpointArtifacts([
          checkpointPath,
          ...(pendingCheckpointSourcePath
            ? [pendingCheckpointSourcePath]
            : []),
          ...ownedBackupPaths,
          ...previousOwnedBackups,
        ]);
      };

      await persistCheckpoint();
      abortSignal.throwIfAborted();

      const chunks = splitIntoChunk(subtitle, 20);
      if (chunks.length === 0) {
        abortSignal.throwIfAborted();
        await writeFinalSubtitleOutput(
          subtitleOutputWriter,
          serializeTranslatedSubtitle(
            parsed,
            params.outputFormat,
            params.assFonts,
            input.sourceExtension
          )
        );
        await checkpointWriter.wait().catch((error: unknown) => {
          console.warn("Failed to finish translation checkpoint:", error);
        });
        await removeSuccessfulCheckpointArtifacts();
        sendProgress(event.sender, {
          taskId: file.taskId,
          filePath: file.path,
          progress: 100,
          status: "done",
          totalCues,
          currentCue: totalCues,
          analysis: analysisData,
          outputPath: translatedOutputPath,
          previewCues: createSubtitlePreview(subtitle, subtitle),
        });
        return;
      }

      // Build analysis context (plot summary + glossary) and attach to all requests
      const analysisPlan = getSubtitleAnalysisPlan(
        analysisData,
        totalCues,
        completedCues,
        MIN_CUES_FOR_CONTEXT_ANALYSIS
      );
      const shouldAnalyze = analysisPlan.shouldAnalyze;
      if (shouldAnalyze) {
        abortSignal.throwIfAborted();
        sendProgress(event.sender, {
          taskId: file.taskId,
          filePath: file.path,
          progress: totalCues > 0 ? (completedCues / totalCues) * 100 : 0,
          status: "analyzing",
          totalCues,
          currentCue: completedCues,
          analysis: null,
          outputPath: translatedOutputPath,
        });
      }

      let combinedAdditional = params.additional || "";
      if (analysisData) {
        combinedAdditional = `${
          combinedAdditional ? combinedAdditional + "\n\n" : ""
        }[Context]\n${analysisData}`;
        analysisCache.set(file.taskId, analysisData);
      } else if (shouldAnalyze) {
        const analysis = await retryTranslation(
          (texts) =>
            analyzeSubtitlesForContext(texts, {
              apiKeys: params.apiKeys || [],
              apiHost: params.apiHost || "https://api.openai.com/v1",
              model: params.model || "",
              lang: params.lang || "",
              temperature: 0.3,
              requestRateLimiter,
              abortSignal,
            }),
          allTexts,
          {
            delayMs: params.delay,
            abortSignal,
          }
        );
        analysisData = analysis;
        const savedAnalysis = await persistCheckpoint();
        if (!savedAnalysis) {
          throw new Error(
            translationErrorCodes.requiredAnalysisCheckpoint
          );
        }
        analysisCache.set(file.taskId, analysis);
        combinedAdditional = `${
          combinedAdditional ? combinedAdditional + "\n\n" : ""
        }[Context]\n${analysis}`;
        sendProgress(event.sender, {
          taskId: file.taskId,
          filePath: file.path,
          progress: totalCues > 0 ? (completedCues / totalCues) * 100 : 0,
          status: "analyzing",
          totalCues,
          currentCue: completedCues,
          analysis,
          outputPath: translatedOutputPath,
        });
      }

      if (analysisPlan.requiresAnalysis && !analysisData?.trim()) {
        throw new Error(translationErrorCodes.incompleteModelOutput);
      }

      abortSignal.throwIfAborted();
      sendProgress(event.sender, {
        taskId: file.taskId,
        filePath: file.path,
        progress: totalCues > 0 ? (completedCues / totalCues) * 100 : 0,
        status: "translating",
        totalCues,
        currentCue: completedCues,
        analysis: analysisData ?? null,
        outputPath: translatedOutputPath,
      });

      // Translate
      const chunkProcessor = async (block: SubtitleCue[]) => {
        abortSignal.throwIfAborted();
        // 以原始索引建立「核心段」和「上下文視窗」
        const contextSize =
          typeof params.contextSize === "number"
            ? params.contextSize
            : DEFAULT_CONTEXT_SIZE;

        const coreIndices = block
          .map((cue) => indexMap.get(cue))
          .filter((n): n is number => typeof n === "number")
          .sort((a: number, b: number) => a - b);

        if (coreIndices.length === 0) return;

        const coreStart = coreIndices[0];
        const coreEnd = coreIndices[coreIndices.length - 1];

        const contextStart = Math.max(0, coreStart - contextSize);
        const contextEnd = Math.min(subtitle.length - 1, coreEnd + contextSize);

        const normalizeCueText = (cue: SubtitleCue) =>
          cue.data.text.replaceAll(/\n/g, " ").trim();
        const translationChunk = {
          before: subtitle.slice(contextStart, coreStart).map(normalizeCueText),
          core: block.map(normalizeCueText),
          after: subtitle
            .slice(coreEnd + 1, contextEnd + 1)
            .map(normalizeCueText),
        };

        // 每個區塊最多自動嘗試三次；失敗後直接交由使用者手動重試。
        const translatedWindow = await retryTranslation(
          async (chunkInput) => {
            const result = await translateSubtitleChunk(chunkInput, {
              ...params,
              apiKeys: params.apiKeys || [],
              apiHost: params.apiHost || "https://api.openai.com/v1",
              model: params.model || "",
              prompt: params.prompt || "",
              lang: params.lang || "",
              additional: combinedAdditional || "",
              temperature:
                typeof params.temperature === "number"
                  ? params.temperature
                  : 1,
              requestRateLimiter,
              abortSignal,
            });

            if (!Array.isArray(result) || result.length !== block.length) {
              throw new Error(
                `Translation output validation failed: expected ${block.length} subtitles, got ${Array.isArray(result) ? result.length : "a non-array result"}`
              );
            }

            return result;
          },
          translationChunk,
          {
            delayMs: 1000,
            abortSignal,
          }
        );

        abortSignal.throwIfAborted();
        // The model receives surrounding context but returns only the core block.
        let chunkCompleted = 0;
        for (const [index, cue] of block.entries()) {
          cue.data.translatedText = translatedWindow[index] ?? "";
          chunkCompleted++;
        }

        abortSignal.throwIfAborted();
        completedCues += chunkCompleted;
        const progress = totalCues > 0 ? (completedCues / totalCues) * 100 : 100;
        const currentCue = Math.min(completedCues, totalCues);
        sendProgress(event.sender, {
          taskId: file.taskId,
          filePath: file.path,
          progress,
          status: "translating",
          totalCues,
          currentCue,
          analysis: analysisData ?? null,
          outputPath: translatedOutputPath,
        });

        // 寫入部分成果供即時預覽
        try {
          await subtitleOutputWriter.write(
            serializeTranslatedSubtitle(
              parsed,
              params.outputFormat,
              params.assFonts,
              input.sourceExtension
            )
          );
        } catch (e) {
          console.warn(
            `Failed to atomically write partial translated file: ${translatedOutputPath}`,
            e
          );
        }

        await persistCheckpoint();
      };

      const activeChunkProcessors = new Set<Promise<void>>();
      const trackedChunkProcessor = (block: SubtitleCue[]) => {
        const processing = chunkProcessor(block).finally(() => {
          activeChunkProcessors.delete(processing);
        });
        activeChunkProcessors.add(processing);
        return processing;
      };

      try {
        for await (const _ of pool(
          params.concurrency,
          chunks,
          trackedChunkProcessor
        )) {
          // Process chunks with the configured per-file concurrency.
        }
      } catch (error: unknown) {
        await Promise.allSettled([...activeChunkProcessors]);
        await checkpointWriter.wait().catch(() => undefined);
        throw error;
      }

      // Final write
      abortSignal.throwIfAborted();
      await writeFinalSubtitleOutput(
        subtitleOutputWriter,
        serializeTranslatedSubtitle(
          parsed,
          params.outputFormat,
          params.assFonts,
          input.sourceExtension
        )
      );
      await checkpointWriter.wait().catch((error: unknown) => {
        console.warn("Failed to finish translation checkpoint:", error);
      });
      await removeSuccessfulCheckpointArtifacts();
      sendProgress(event.sender, {
        taskId: file.taskId,
        filePath: file.path,
        progress: 100,
        status: "done",
        totalCues,
        currentCue: totalCues,
        analysis: analysisData ?? null,
        outputPath: translatedOutputPath,
        previewCues: createSubtitlePreview(subtitle, subtitle),
      });
      console.log(`Saved translated file to: ${translatedOutputPath}`);
    } catch (e: unknown) {
      if (abortSignal.aborted) return;
      console.error(`Batch translation error for ${file.path}:`, e);
      sendProgress(event.sender, {
        taskId: file.taskId,
        filePath: file.path,
        progress: 0,
        status: "error",
        error: getErrorMessage(e),
        outputPath,
      });
    } finally {
      releasePathClaims?.();
    }
  };

  try {
    for await (const _ of pool(3, files, processFile)) {
      // Process all files in parallel with concurrency 3
    }
  } finally {
    for (const unregister of unregisterTranslationControllers) unregister();
    requestRateLimiterLease.release();
  }
  return { success: true };
});

// Allow renderer to fetch cached analysis for a task (in case progress event missed)
ipcMain.handle("get-analysis", async (event, taskId: unknown) => {
  assertTrustedSender(event);
  if (!isTranslationTaskId(taskId)) {
    throw new Error("Invalid translation task ID");
  }
  return analysisCache.get(taskId) ?? null;
});

ipcMain.handle("get-subtitle-preview", async (event, request: unknown) => {
  assertTrustedSender(event);
  const { taskId, filePath: validatedPath, outputPath } =
    subtitlePreviewRequestSchema.parse(request);
  const input = readTranslationInput(validatedPath, taskId);
  const requestedOutputExtension = outputPath
    ? path.extname(outputPath).slice(1).toLowerCase()
    : undefined;
  if (
    requestedOutputExtension &&
    !supportedExtensions.has(requestedOutputExtension as SubtitleFileExtension)
  ) {
    throw new Error(translationErrorCodes.unsupportedFileExtension);
  }
  const parsed = input.parsed;
  const subtitle = getSubtitleCues(parsed);

  if (input.cacheDocument) {
    return { cues: createSubtitlePreview(subtitle, subtitle) };
  }

  const checkpointPath = input.checkpointPath;
  let translatedSubtitle: SubtitleCue[] | undefined;
  const matchingCheckpoint = input.sourceFingerprint
    ? readMatchingCheckpoint(
        checkpointPath,
        {
          sourceName: input.sourceName,
          format: input.sourceExtension,
          fingerprint: input.sourceFingerprint,
        },
        taskId
      )
    : undefined;
  if (matchingCheckpoint) {
    translatedSubtitle = getSubtitleCues(matchingCheckpoint.subtitle);
  }

  if (!translatedSubtitle) {
    const outputCandidates = subtitleOutputFormats.map((format) =>
      getTranslatedPath(validatedPath, format, undefined, input.sourceName)
    );
    const translatedPath =
      outputPath ??
      outputCandidates.find((candidate) => fs.existsSync(candidate)) ??
      outputCandidates[0];

    if (fs.existsSync(translatedPath)) {
      const translatedContent = fs.readFileSync(translatedPath, "utf8");
      const translatedExtension = path
        .extname(translatedPath)
        .slice(1)
        .toLowerCase();
      const translatedParsed: ParsedSubtitle = parseSubtitle(
        translatedContent,
        translatedExtension
      );
      translatedSubtitle = getSubtitleCues(translatedParsed);
    }
  }

  return { cues: createSubtitlePreview(subtitle, translatedSubtitle) };
});
