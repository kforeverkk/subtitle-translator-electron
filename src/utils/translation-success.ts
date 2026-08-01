export const TRANSLATION_SUCCESS_PROMPT_INTERVAL = 20;

function isValidTranslationSuccessCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function normalizeTranslationSuccessCount(value: unknown): number {
  return isValidTranslationSuccessCount(value) ? Math.floor(value) : 0;
}

export function getTranslationSuccessPromptCount(
  previousCount: unknown,
  currentCount: unknown
): number {
  if (
    !isValidTranslationSuccessCount(previousCount) ||
    !isValidTranslationSuccessCount(currentCount)
  ) {
    return 0;
  }

  const previous = normalizeTranslationSuccessCount(previousCount);
  const current = normalizeTranslationSuccessCount(currentCount);
  if (current <= previous) return 0;

  return (
    Math.floor(current / TRANSLATION_SUCCESS_PROMPT_INTERVAL) -
    Math.floor(previous / TRANSLATION_SUCCESS_PROMPT_INTERVAL)
  );
}

export function reachedTranslationSuccessPrompt(
  previousCount: unknown,
  currentCount: unknown
): boolean {
  return getTranslationSuccessPromptCount(previousCount, currentCount) > 0;
}
