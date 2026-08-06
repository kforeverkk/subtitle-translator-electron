export const translationErrorCodes = {
  unsupportedInputFile: "ERR_UNSUPPORTED_TRANSLATION_INPUT_FILE",
  inputPathNotFile: "ERR_TRANSLATION_INPUT_NOT_FILE",
  unsupportedSubtitleFormat: "ERR_UNSUPPORTED_SUBTITLE_FORMAT",
  subtitleEncoding: "ERR_SUBTITLE_ENCODING_UNRECOGNIZED",
  invalidCheckpoint: "ERR_INVALID_TRANSLATION_CHECKPOINT",
  incompatibleCheckpoint: "ERR_INCOMPATIBLE_TRANSLATION_CHECKPOINT",
  noValidApiKeys: "ERR_NO_VALID_API_KEYS",
  unsupportedFileExtension: "ERR_UNSUPPORTED_FILE_EXTENSION",
  outputPathConflict: "ERR_TRANSLATION_OUTPUT_PATH_CONFLICT",
  repetitiveModelOutput: "ERR_REPETITIVE_MODEL_OUTPUT",
  incompleteModelOutput: "ERR_INCOMPLETE_MODEL_OUTPUT",
  requiredAnalysisCheckpoint:
    "ERR_REQUIRED_ANALYSIS_CHECKPOINT_SAVE_FAILED",
  ssaToAssConversion: "ERR_SSA_TO_ASS_CONVERSION",
} as const;
