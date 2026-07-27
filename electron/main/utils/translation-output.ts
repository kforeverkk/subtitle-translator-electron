export function isCompletedModelFinishReason(
  finishReason: string
): boolean {
  return finishReason === "stop";
}

const INCOMPLETE_MODEL_OUTPUT_ERROR_CODE = "ERR_INCOMPLETE_MODEL_OUTPUT";

/**
 * Reject incomplete model responses before they can be associated with subtitle
 * cues. Callers can treat this error as retryable and retranslate the complete
 * block with its original context.
 */
export function assertCompleteTranslationOutput(
  core: readonly string[],
  output: readonly string[]
): void {
  if (
    output.length !== core.length ||
    output.some(
      (translation, index) =>
        core[index].trim().length > 0 && translation.trim().length === 0
    )
  ) {
    throw new Error(
      `${INCOMPLETE_MODEL_OUTPUT_ERROR_CODE}: expected ${core.length} non-empty subtitles, got ${output.length}`
    );
  }
}

const REPETITION_WINDOW_SIZE = 8_192;
const REPETITION_CHECK_INTERVAL = 256;
const MAX_REPETITION_PERIOD = 2_048;
const MIN_REPETITION_COUNT = 4;

function hasExactShortPeriod(value: string): boolean {
  const prefixLengths = new Uint16Array(value.length);

  for (let index = 1; index < value.length; index++) {
    let prefixLength = prefixLengths[index - 1];
    while (
      prefixLength > 0 &&
      value.charCodeAt(index) !== value.charCodeAt(prefixLength)
    ) {
      prefixLength = prefixLengths[prefixLength - 1];
    }
    if (value.charCodeAt(index) === value.charCodeAt(prefixLength)) {
      prefixLength++;
    }
    prefixLengths[index] = prefixLength;
  }

  const period = value.length - prefixLengths[value.length - 1];
  return (
    period <= MAX_REPETITION_PERIOD &&
    Math.floor(value.length / period) >= MIN_REPETITION_COUNT
  );
}

/**
 * Detect a long, exact cycle in streamed model output without reacting to
 * ordinary short repetitions such as lyrics or repeated subtitle cues.
 */
export class TranslationOutputRepetitionGuard {
  private buffer = "";
  private uncheckedCharacterCount = 0;

  push(text: string): boolean {
    if (text.length === 0) return false;

    this.buffer = `${this.buffer}${text}`.slice(-REPETITION_WINDOW_SIZE);
    this.uncheckedCharacterCount += text.length;

    if (
      this.buffer.length < REPETITION_WINDOW_SIZE ||
      this.uncheckedCharacterCount < REPETITION_CHECK_INTERVAL
    ) {
      return false;
    }

    this.uncheckedCharacterCount = 0;
    return hasExactShortPeriod(this.buffer);
  }
}
