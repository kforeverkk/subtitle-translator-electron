import type {
  BatchProgress,
  SubtitleFile,
} from "../types/electron-api";

export type FileProgress = Pick<BatchProgress, "progress" | "status"> &
  Partial<Omit<BatchProgress, "progress" | "status" | "previewCues">> & {
    model?: string;
    targetLanguage?: string;
  };

export function markBatchInvocationFailed(
  previous: Record<string, FileProgress>,
  files: readonly SubtitleFile[],
  failure: {
    error: string;
    model: string;
    targetLanguage: string;
  }
): Record<string, FileProgress> {
  const next = { ...previous };

  for (const file of files) {
    const current = previous[file.path];
    if (current?.status === "done" || current?.status === "error") continue;

    next[file.path] = {
      ...(current ?? {}),
      progress: 0,
      status: "error",
      error: failure.error,
      model: current?.model ?? failure.model,
      targetLanguage: current?.targetLanguage ?? failure.targetLanguage,
    };
  }

  return next;
}
