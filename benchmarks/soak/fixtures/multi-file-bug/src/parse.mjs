/**
 * Parse a small CSV document into rows of coerced values.
 *
 * This file composes the two above and is correct as written. It is here so the
 * defect is genuinely spread across the modules a repair has to reach, rather
 * than sitting in the one file a reader opens first.
 */

import { coerceField } from "./coerce.mjs";
import { tokenizeLine } from "./tokenize.mjs";

export function parseCsv(text) {
	if (typeof text !== "string") throw new TypeError("text must be a string");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => tokenizeLine(line).map(coerceField));
}
