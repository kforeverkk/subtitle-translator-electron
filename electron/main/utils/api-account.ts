import { createHash } from "node:crypto";
import { translationErrorCodes } from "../../shared/translation-error-codes.ts";

export function getFirstValidApiKey(apiKeys: readonly string[]): string {
  const apiKey = apiKeys.map((key) => key.trim()).find(Boolean);
  if (!apiKey) {
    throw new Error(translationErrorCodes.noValidApiKeys);
  }
  return apiKey;
}

export function normalizeApiBaseUrl(apiHost: string): string {
  const url = new URL(apiHost.trim());
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const serialized = url.toString();
  return url.pathname === "/" && !url.search
    ? serialized.replace(/\/$/, "")
    : serialized;
}

export function createApiAccountIdentity(
  apiHost: string,
  apiKey: string
): string {
  const keyDigest = createHash("sha256").update(apiKey).digest("hex");
  return `${normalizeApiBaseUrl(apiHost)}\n${keyDigest}`;
}
