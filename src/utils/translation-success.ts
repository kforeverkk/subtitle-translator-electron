export const TRANSLATION_SUCCESS_PROMPT_INTERVAL = 20;

export function reachedTranslationSuccessPrompt(
  previousCount: number,
  currentCount: number
): boolean {
  if (
    !Number.isFinite(previousCount) ||
    !Number.isFinite(currentCount) ||
    currentCount <= previousCount
  ) {
    return false;
  }

  return (
    Math.floor(currentCount / TRANSLATION_SUCCESS_PROMPT_INTERVAL) >
    Math.floor(previousCount / TRANSLATION_SUCCESS_PROMPT_INTERVAL)
  );
}
