import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AvailableModel,
  BatchProgress,
  BatchTranslationRequest,
  CheckpointSaveWarning,
  SubtitlePreviewRequest,
} from "../../src/types/electron-api";

const electronAPI = {
  getFilePath(file: File): string {
    return webUtils.getPathForFile(file);
  },

  selectDirectory(defaultPath?: string): Promise<string | null> {
    return ipcRenderer.invoke("select-directory", defaultPath);
  },

  listModels(request: { apiKey: string; apiHost: string }): Promise<AvailableModel[]> {
    return ipcRenderer.invoke("list-models", request);
  },

  translateBatch(request: BatchTranslationRequest) {
    return ipcRenderer.invoke("batch-translate", request);
  },

  cancelTranslation(taskId: string): void {
    ipcRenderer.send("cancel-translation", taskId);
  },

  getSubtitlePreview(request: SubtitlePreviewRequest) {
    return ipcRenderer.invoke("get-subtitle-preview", request);
  },

  getAnalysis(taskId: string) {
    return ipcRenderer.invoke("get-analysis", taskId);
  },

  openExternal(url: string) {
    return ipcRenderer.invoke("open-external", url);
  },

  setMenuLocale(locale: string): Promise<void> {
    return ipcRenderer.invoke("set-menu-locale", locale);
  },

  onBatchProgress(listener: (data: BatchProgress) => void) {
    const handler = (_event: Electron.IpcRendererEvent, data: BatchProgress) => {
      listener(data);
    };

    ipcRenderer.on("batch-progress", handler);
    return () => ipcRenderer.removeListener("batch-progress", handler);
  },

  onCheckpointSaveWarning(listener: (data: CheckpointSaveWarning) => void) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: CheckpointSaveWarning
    ) => {
      listener(data);
    };

    ipcRenderer.on("checkpoint-save-warning", handler);
    return () => ipcRenderer.removeListener("checkpoint-save-warning", handler);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
