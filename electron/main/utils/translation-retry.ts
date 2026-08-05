import {
  APICallError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
} from "ai";
import { setTimeout as sleep } from "node:timers/promises";
import { parseSsaToAssConversionError } from "../../shared/ssa-to-ass-error";
import { translationErrorCodes } from "../../shared/translation-error-codes";
import { getRetryAfterMsFromHeaders } from "./retry-after";

const MAX_AUTOMATIC_TRANSLATION_ATTEMPTS = 3;

type RetrySleep = (
  delayMs: number,
  abortSignal?: AbortSignal
) => Promise<void>;

export interface TranslationRetryEvent {
  attempt: number;
  backoffMs: number;
  error: unknown;
  message: string;
  name?: string;
}

export interface RetryTranslationOptions {
  delayMs?: number;
  abortSignal?: AbortSignal;
  sleep?: RetrySleep;
  random?: () => number;
  onRetry?: (event: TranslationRetryEvent) => void;
}

function normalizeErrorMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ");
}

export function getErrorDetails(error: unknown): {
  message: string;
  name?: string;
  status?: number;
} {
  const errorRecord =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const cause =
    typeof errorRecord.cause === "object" && errorRecord.cause !== null
      ? (errorRecord.cause as Record<string, unknown>)
      : {};
  const rawMessages = [
    error instanceof Error ? error.message : undefined,
    typeof error === "string" ? error : undefined,
    typeof errorRecord.message === "string" ? errorRecord.message : undefined,
    typeof cause.message === "string" ? cause.message : undefined,
  ].filter((message): message is string => Boolean(message));
  const structuredConversionMessage = rawMessages.find((message) =>
    Boolean(parseSsaToAssConversionError(message))
  );
  const normalizedMessages = [
    ...new Set(
      rawMessages
        .map(normalizeErrorMessage)
        .filter((message) => message.length > 0)
    ),
  ];
  const response =
    typeof errorRecord.response === "object" && errorRecord.response !== null
      ? (errorRecord.response as Record<string, unknown>)
      : {};

  return {
    message:
      structuredConversionMessage ??
      (normalizedMessages.join(" | ") || "Unknown error"),
    name:
      typeof errorRecord.name === "string"
        ? errorRecord.name
        : typeof cause.name === "string"
          ? cause.name
          : undefined,
    status:
      typeof errorRecord.statusCode === "number"
        ? errorRecord.statusCode
        : typeof errorRecord.status === "number"
          ? errorRecord.status
          : typeof response.status === "number"
            ? response.status
            : typeof cause.statusCode === "number"
              ? cause.statusCode
              : typeof cause.status === "number"
                ? cause.status
                : undefined,
  };
}

export function getRetryAfterMs(error: unknown): number {
  if (!APICallError.isInstance(error) || !error.responseHeaders) return 0;
  return getRetryAfterMsFromHeaders(error.responseHeaders);
}

export function isRetryableTranslationError(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable;
  if (NoObjectGeneratedError.isInstance(error)) return true;

  const { message, status } = getErrorDetails(error);
  if (NoOutputGeneratedError.isInstance(error)) {
    const cause =
      typeof error.cause === "object" && error.cause !== null
        ? error.cause
        : undefined;
    if (APICallError.isInstance(cause)) return cause.isRetryable;
    if (typeof status === "number") {
      return status === 429 || status >= 500;
    }
    return true;
  }

  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return true;
  }

  return (
    message.includes(translationErrorCodes.incompleteModelOutput) ||
    /network|timeout|timed out|econnreset|econnrefused|enotfound|socket hang up/i.test(
      message
    )
  );
}

export function getErrorMessage(error: unknown): string {
  return getErrorDetails(error).message;
}

const defaultSleep: RetrySleep = (delayMs, abortSignal) =>
  sleep(delayMs, undefined, { signal: abortSignal });

export async function retryTranslation<TInput, TResult>(
  fn: (input: TInput) => Promise<TResult>,
  input: TInput,
  options: RetryTranslationOptions = {}
): Promise<TResult> {
  const {
    delayMs = 1000,
    abortSignal,
    sleep: wait = defaultSleep,
    random = Math.random,
    onRetry,
  } = options;

  for (
    let attempt = 1;
    attempt <= MAX_AUTOMATIC_TRANSLATION_ATTEMPTS;
    attempt++
  ) {
    abortSignal?.throwIfAborted();
    try {
      return await fn(input);
    } catch (error: unknown) {
      abortSignal?.throwIfAborted();
      if (
        attempt === MAX_AUTOMATIC_TRANSLATION_ATTEMPTS ||
        !isRetryableTranslationError(error)
      ) {
        throw error;
      }

      const { message, name } = getErrorDetails(error);
      const exponentialBackoff =
        Math.max(0, delayMs) * 2 ** (attempt - 1) +
        Math.floor(random() * 250);
      const backoffMs = Math.max(exponentialBackoff, getRetryAfterMs(error));
      const retryEvent = {
        attempt,
        backoffMs,
        error,
        message,
        name,
      };

      if (onRetry) {
        onRetry(retryEvent);
      } else {
        console.warn(
          `Translation attempt ${attempt} failed: ${message || name || "unknown error"}. Retrying in ${backoffMs}ms...`
        );
      }
      await wait(backoffMs, abortSignal);
    }
  }

  throw new Error("Automatic translation retry loop exited unexpectedly");
}
