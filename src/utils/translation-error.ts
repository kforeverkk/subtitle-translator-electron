import {
  parseSsaToAssConversionError,
  type SsaToAssConversionReason,
} from "../../electron/shared/ssa-to-ass-error";
import { translationErrorCodes } from "../../electron/shared/translation-error-codes";

export type TranslateErrorMessage = (
  id: string,
  values?: Record<string, unknown>
) => string;

const translationErrorMessageIds: Record<string, string> = {
  [translationErrorCodes.unsupportedInputFile]: "error.unsupportedInputFile",
  [translationErrorCodes.inputPathNotFile]: "error.inputPathNotFile",
  [translationErrorCodes.unsupportedSubtitleFormat]: "error.unsupportedSubtitleFormat",
  [translationErrorCodes.subtitleEncoding]: "error.subtitleEncoding",
  [translationErrorCodes.invalidCheckpoint]: "error.invalidCheckpoint",
  [translationErrorCodes.incompatibleCheckpoint]: "error.incompatibleCheckpoint",
  [translationErrorCodes.noValidApiKeys]: "error.noValidApiKeys",
  [translationErrorCodes.unsupportedFileExtension]: "error.unsupportedFileExtension",
  [translationErrorCodes.outputPathConflict]: "error.outputPathConflict",
  [translationErrorCodes.repetitiveModelOutput]: "error.repetitiveModelOutput",
  [translationErrorCodes.incompleteModelOutput]: "error.incompleteModelOutput",
};

const conversionReasonMessageIds: Record<SsaToAssConversionReason, string> = {
  "missing-source": "error.ssaToAssConversion.missingSource",
  "missing-section": "error.ssaToAssConversion.missingSection",
  "missing-format": "error.ssaToAssConversion.missingFormat",
  "invalid-field": "error.ssaToAssConversion.invalidField",
  "missing-style": "error.ssaToAssConversion.missingStyle",
  "invalid-output": "error.ssaToAssConversion.invalidOutput",
};

export function getLocalizedTranslationError(
  error: unknown,
  fallbackId: string,
  t: TranslateErrorMessage
): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const conversion = parseSsaToAssConversionError(message);
  if (conversion) {
    const reason = t(conversionReasonMessageIds[conversion.reason], {
      value: conversion.value ?? "",
    });
    return t("error.ssaToAssConversion", {
      location: conversion.location,
      reason,
    });
  }
  const messageId = translationErrorMessageIds[message];
  return messageId ? t(messageId) : message || t(fallbackId);
}
