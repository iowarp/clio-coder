/**
 * Legacy descriptor placeholders remain until the runtime adapters migrate.
 * Resolution never promotes a descriptor context placeholder to a serving
 * limit; an unreported window remains unknown.
 */
export const CLIO_MIN_CONTEXT_WINDOW = 131_072;

/** Default requested output budget when no narrower request or model cap exists. */
export const CLIO_MIN_MAX_OUTPUT_TOKENS = 32_768;
