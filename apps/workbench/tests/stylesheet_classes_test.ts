import { ok } from "node:assert/strict";

const WORKBENCH_CLASS_PREFIX = "workbench-";

function extractClassNameStringLiterals(source: string): string[] {
	const literals: string[] = [];
	const attrRegex = /\bclassName\s*=\s*/gu;
	let match: RegExpExecArray | null;

	while ((match = attrRegex.exec(source)) !== null) {
		const startIndex = match.index + match[0].length;
		if (startIndex >= source.length) break;
		const firstChar = source[startIndex];

		if (firstChar === '"' || firstChar === "'") {
			const quote = firstChar;
			let i = startIndex + 1;
			let str = "";
			while (i < source.length) {
				if (source[i] === "\\") {
					str += source[i + 1] ?? "";
					i += 2;
				} else if (source[i] === quote) {
					break;
				} else {
					str += source[i];
					i++;
				}
			}
			literals.push(str);
		} else if (firstChar === "{") {
			let depth = 0;
			let i = startIndex;
			let inString: string | null = null;
			const exprStart = startIndex + 1;
			let exprEnd = -1;

			while (i < source.length) {
				const ch = source[i];
				if (inString !== null) {
					if (ch === "\\") {
						i += 2;
					} else if (ch === inString) {
						inString = null;
						i++;
					} else {
						i++;
					}
				} else if (ch === '"' || ch === "'" || ch === "`") {
					inString = ch;
					i++;
				} else if (ch === "{") {
					depth++;
					i++;
				} else if (ch === "}") {
					depth--;
					if (depth === 0) {
						exprEnd = i;
						break;
					}
					i++;
				} else {
					i++;
				}
			}

			if (exprEnd !== -1) {
				const expr = source.slice(exprStart, exprEnd);
				for (const sm of expr.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/gsu)) {
					if (sm[1] !== undefined) {
						literals.push(sm[1]);
					}
				}
				for (const sm of expr.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/gsu)) {
					if (sm[1] !== undefined) {
						literals.push(sm[1]);
					}
				}
				for (const sm of expr.matchAll(/`([^`\\]*(?:\\.[^`\\]*)*)`/gsu)) {
					if (sm[1] !== undefined) {
						const quasis = sm[1].split(/\$\{[^}]*\}/su);
						for (const quasi of quasis) {
							literals.push(quasi);
						}
					}
				}
			}
		}
	}

	return literals;
}

Deno.test("all workbench-prefixed class tokens used in components exist in styles.css", async () => {
	const stylesheetUrl = new URL("../src/styles.css", import.meta.url);
	const stylesheet = await Deno.readTextFile(stylesheetUrl);
	const srcDir = new URL("../src/", import.meta.url);

	let verifiedTokenCount = 0;

	for await (const entry of Deno.readDir(srcDir)) {
		if (!entry.isFile || !entry.name.endsWith(".tsx")) {
			continue;
		}
		const fileUrl = new URL(entry.name, srcDir);
		const source = await Deno.readTextFile(fileUrl);
		const stringLiterals = extractClassNameStringLiterals(source);

		for (const literal of stringLiterals) {
			const tokens = literal.split(/\s+/u).filter(Boolean);
			for (const token of tokens) {
				if (token.startsWith(WORKBENCH_CLASS_PREFIX)) {
					const selectorPattern = new RegExp(`\\.${token}(?![a-zA-Z0-9_-])`, "u");
					ok(
						selectorPattern.test(stylesheet),
						`Class "${token}" used in ${entry.name} does not exist as a selector in styles.css`,
					);
					verifiedTokenCount++;
				}
			}
		}
	}

	ok(verifiedTokenCount > 0, "Expected at least one workbench class token to be verified");
});
