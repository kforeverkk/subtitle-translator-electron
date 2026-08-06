interface WebContentsMessageTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export class TranslationControllerRegistry {
  private readonly controllersByTaskId = new Map<
    string,
    Set<AbortController>
  >();

  has(taskId: string): boolean {
    return this.controllersByTaskId.has(taskId);
  }

  register(taskId: string, controller: AbortController): () => void {
    const controllers =
      this.controllersByTaskId.get(taskId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllersByTaskId.set(taskId, controllers);
    let registered = true;

    return () => {
      if (!registered) return;
      registered = false;
      controllers.delete(controller);
      if (controllers.size === 0) {
        this.controllersByTaskId.delete(taskId);
      }
    };
  }

  cancel(taskId: string): void {
    for (const controller of [
      ...(this.controllersByTaskId.get(taskId) ?? []),
    ]) {
      controller.abort();
    }
  }

  cancelAll(): void {
    for (const controllers of [...this.controllersByTaskId.values()]) {
      for (const controller of [...controllers]) {
        controller.abort();
      }
    }
  }
}

export function sendWebContentsMessageSafely(
  sender: WebContentsMessageTarget,
  channel: string,
  payload: unknown
): boolean {
  if (sender.isDestroyed()) return false;

  try {
    sender.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}
