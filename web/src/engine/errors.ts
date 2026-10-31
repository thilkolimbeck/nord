/**
 * The error types the engine throws. Messages are identical to the Python
 * reference (nordconv), so the UI can show them as they are.
 */

/** A file is not a valid Nord program of the expected kind (Python: nordconv.cbin.NordFileError). */
export class NordFormatError extends Error {
  override name = 'NordFormatError';
  /** The file name passed to convert(), when there was one. Never part of the message. */
  fileName?: string;
}

/** The output failed its own verification, or the template is unusable (Python: nordconv.convert.ConversionError). */
export class ConversionError extends Error {
  override name = 'ConversionError';
  /** The file name passed to convert(), when there was one. Never part of the message. */
  fileName?: string;
}
