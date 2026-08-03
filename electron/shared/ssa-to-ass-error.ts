import { translationErrorCodes } from "./translation-error-codes";

export const ssaToAssConversionReasons = [
  "missing-source",
  "missing-section",
  "missing-format",
  "invalid-field",
  "missing-style",
  "invalid-output",
] as const;

export type SsaToAssConversionReason =
  (typeof ssaToAssConversionReasons)[number];

export interface SsaToAssConversionErrorDetails {
  reason: SsaToAssConversionReason;
  location: string;
  value?: string;
}

const prefix = `${translationErrorCodes.ssaToAssConversion}:`;

function isDetails(value: unknown): value is SsaToAssConversionErrorDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Record<string, unknown>;
  return (
    typeof details.reason === "string" &&
    ssaToAssConversionReasons.includes(
      details.reason as SsaToAssConversionReason
    ) &&
    typeof details.location === "string" &&
    details.location.trim().length > 0 &&
    (details.value === undefined || typeof details.value === "string")
  );
}

export function createSsaToAssConversionError(
  details: SsaToAssConversionErrorDetails
): Error {
  return new Error(`${prefix}${encodeURIComponent(JSON.stringify(details))}`);
}

export function parseSsaToAssConversionError(
  message: string
): SsaToAssConversionErrorDetails | undefined {
  if (!message.startsWith(prefix)) return undefined;
  try {
    const value = JSON.parse(decodeURIComponent(message.slice(prefix.length)));
    return isDetails(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
