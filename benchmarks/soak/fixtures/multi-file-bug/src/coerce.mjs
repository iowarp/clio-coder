/**
 * Coerce a CSV field to the value it represents.
 *
 * An empty field is null, a field that is entirely an integer or decimal is a
 * number, and everything else stays the string it was.
 *
 * DEFECT 2: the numeric test uses `Number(field)`, which accepts leading and
 * trailing whitespace, the empty string, and hexadecimal and exponent forms
 * that are not the CSV's numeric syntax. `"0x10"` becomes 16 and ` 1 ` becomes
 * 1, so data the file did not contain appears in the parsed rows.
 */

export function coerceField(field) {
	if (typeof field !== "string") throw new TypeError("field must be a string");
	if (field.length === 0) return null;
	const asNumber = Number(field);
	if (!Number.isNaN(asNumber)) return asNumber;
	return field;
}
