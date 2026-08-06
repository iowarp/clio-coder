/**
 * Split a CSV line into fields.
 *
 * A field may be double-quoted, in which case a doubled quote inside it is one
 * literal quote and a comma inside it is data rather than a separator.
 *
 * DEFECT 1: the closing quote is consumed but the doubled-quote escape is not
 * recognised, so `"a""b"` tokenizes as two fields instead of the single field
 * `a"b`.
 */

export function tokenizeLine(line) {
	if (typeof line !== "string") throw new TypeError("line must be a string");
	const fields = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (char === "," && !quoted) {
			fields.push(field);
			field = "";
			continue;
		}
		field += char;
	}
	fields.push(field);
	return fields;
}
