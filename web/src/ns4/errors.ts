/**
 * The error types the Stage 4 program code throws. Their messages are complete sentences, so
 * the UI can show them as they are.
 */

/** A file is not a valid Nord program of the expected kind. */
export class NordFormatError extends Error {
  override name = 'NordFormatError';
}

/** A written file failed its own verification (see verify.ts). */
export class ConversionError extends Error {
  override name = 'ConversionError';
}
