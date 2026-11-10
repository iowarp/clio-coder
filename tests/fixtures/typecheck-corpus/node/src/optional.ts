import type { Options } from "./lib/public-api.js";

// exactOptionalPropertyTypes: undefined is not an omitted property.
export const explicitUndefined: Options = { label: undefined, retries: 1 };
const maybe: string | undefined = process.env.CORPUS;
export const spread: Options = { retries: 1, ...(maybe !== undefined ? { label: maybe } : {}) };
export const direct: Options = { retries: 1, label: maybe };
