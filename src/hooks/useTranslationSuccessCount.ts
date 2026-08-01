import { useCallback } from "react";
import { useLocalStorage } from "usehooks-ts";
import { normalizeTranslationSuccessCount } from "@/utils/translation-success";

export const TRANSLATION_SUCCESS_COUNT_KEY = "translation_success_count";

export default function useTranslationSuccessCount() {
  const [storedCount, setStoredCount] = useLocalStorage<unknown>(
    TRANSLATION_SUCCESS_COUNT_KEY,
    0
  );
  const count = normalizeTranslationSuccessCount(storedCount);

  const increment = useCallback(() => {
    setStoredCount(
      (previousCount: unknown) =>
        normalizeTranslationSuccessCount(previousCount) + 1
    );
  }, [setStoredCount]);

  return [count, increment] as const;
}
