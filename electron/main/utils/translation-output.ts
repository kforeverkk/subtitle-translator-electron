import type { Output as AIOutput } from "ai";

export function isCompletedModelFinishReason(
  finishReason: string
): boolean {
  return finishReason === "stop";
}

/**
 * Validate either the object wrapper used by AI SDK's array output mode or a
 * bare JSON array returned by an OpenAI-compatible endpoint.
 */
export function parseTranslationOutput(value: unknown): string[] {
  const elements = Array.isArray(value)
    ? value
    : typeof value === "object" &&
        value !== null &&
        "elements" in value &&
        Array.isArray(value.elements)
      ? value.elements
      : undefined;

  if (!elements || elements.some((element) => typeof element !== "string")) {
    throw new Error(
      "Translation output validation failed: expected an array of strings"
    );
  }

  return elements;
}

export function withBareTranslationArrayFallback(
  output: AIOutput.Output<string[], string[], string>
): AIOutput.Output<string[], string[], string> {
  return {
    ...output,
    async parseCompleteOutput(options, context) {
      try {
        return await output.parseCompleteOutput(options, context);
      } catch (error) {
        let parsedOutput: unknown;
        try {
          parsedOutput = JSON.parse(options.text);
        } catch {
          throw error;
        }

        if (!Array.isArray(parsedOutput)) throw error;

        try {
          return parseTranslationOutput(parsedOutput);
        } catch {
          throw error;
        }
      }
    },
  };
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
