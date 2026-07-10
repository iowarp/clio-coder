/**
 * Deterministic, declared-static CMake extraction.
 *
 * This intentionally recognizes only a small set of built-in declarations. It
 * does not evaluate variables, generator expressions, conditions, functions,
 * or macros. The resulting symbols and imports can therefore use the existing
 * codewiki schema without pretending to model CMake execution.
 */

export interface CMakeExtractedSymbol {
	name: string;
	kind: "const";
	line: number;
	sig?: string;
}

export interface CMakeExtraction {
	symbols: CMakeExtractedSymbol[];
	imports: string[];
}

interface CMakeInvocation {
	name: string;
	line: number;
	args: string[];
}

interface BracketBlock {
	content: string;
	end: number;
}

const SOURCE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cpp",
	".cxx",
	".cu",
	".cuh",
	".h",
	".hh",
	".hpp",
	".hxx",
	".java",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".py",
	".pyw",
	".rb",
	".rs",
	".cs",
	".ts",
	".tsx",
]);

const TARGET_SOURCE_KEYWORDS = new Set([
	"PUBLIC",
	"PRIVATE",
	"INTERFACE",
	"BEFORE",
	"FILE_SET",
	"TYPE",
	"BASE_DIRS",
	"FILES",
]);

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort(compareStrings);
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\n") starts.push(index + 1);
	}
	return starts;
}

function lineAt(starts: ReadonlyArray<number>, offset: number): number {
	let low = 0;
	let high = starts.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((starts[middle] ?? 0) <= offset) low = middle + 1;
		else high = middle;
	}
	return Math.max(1, low);
}

function readBracketBlock(text: string, index: number): BracketBlock | null {
	if (text[index] !== "[") return null;
	let delimiterEnd = index + 1;
	while (text[delimiterEnd] === "=") delimiterEnd += 1;
	if (text[delimiterEnd] !== "[") return null;
	const equals = text.slice(index + 1, delimiterEnd);
	const close = `]${equals}]`;
	const contentStart = delimiterEnd + 1;
	const closeStart = text.indexOf(close, contentStart);
	if (closeStart === -1) return null;
	return {
		content: text.slice(contentStart, closeStart),
		end: closeStart + close.length,
	};
}

function skipComment(text: string, index: number): number {
	const bracket = readBracketBlock(text, index + 1);
	if (bracket) return bracket.end;
	const newline = text.indexOf("\n", index + 1);
	return newline === -1 ? text.length : newline + 1;
}

function skipTrivia(text: string, start: number): number {
	let index = start;
	while (index < text.length) {
		if (/\s/.test(text[index] ?? "")) {
			index += 1;
			continue;
		}
		if (text[index] === "#") {
			index = skipComment(text, index);
			continue;
		}
		break;
	}
	return index;
}

function readQuotedArgument(text: string, start: number): { content: string; end: number } | null {
	let content = "";
	for (let index = start + 1; index < text.length; index += 1) {
		const current = text[index] ?? "";
		if (current === '"') return { content, end: index + 1 };
		if (current === "\\") {
			const next = text[index + 1];
			if (next === undefined) return null;
			if (next === "\n") {
				index += 1;
				continue;
			}
			content += next;
			index += 1;
			continue;
		}
		content += current;
	}
	return null;
}

function parseInvocation(
	text: string,
	name: string,
	line: number,
	openParen: number,
): { invocation: CMakeInvocation; end: number } | null {
	const args: string[] = [];
	let current = "";
	let depth = 1;
	let index = openParen + 1;

	const flush = (): void => {
		if (current.length > 0) args.push(current);
		current = "";
	};

	while (index < text.length) {
		const char = text[index] ?? "";
		if (/\s/.test(char)) {
			flush();
			index += 1;
			continue;
		}
		if (char === "#") {
			flush();
			index = skipComment(text, index);
			continue;
		}
		if (char === '"') {
			const quoted = readQuotedArgument(text, index);
			if (!quoted) return null;
			current += quoted.content;
			index = quoted.end;
			continue;
		}
		if (char === "[") {
			const bracket = readBracketBlock(text, index);
			if (bracket) {
				current += bracket.content;
				index = bracket.end;
				continue;
			}
		}
		if (char === "\\") {
			const next = text[index + 1];
			if (next === undefined) return null;
			if (next === "\n") {
				index += 2;
				continue;
			}
			current += next;
			index += 2;
			continue;
		}
		if (char === ";" && depth === 1) {
			flush();
			index += 1;
			continue;
		}
		if (char === "(") {
			depth += 1;
			current += char;
			index += 1;
			continue;
		}
		if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				flush();
				return {
					invocation: { name, line, args },
					end: index + 1,
				};
			}
			current += char;
			index += 1;
			continue;
		}
		current += char;
		index += 1;
	}
	return null;
}

function scanInvocations(text: string): CMakeInvocation[] {
	const invocations: CMakeInvocation[] = [];
	const starts = lineStarts(text);
	let index = 0;
	while (index < text.length) {
		index = skipTrivia(text, index);
		if (index >= text.length) break;
		if (text[index] === '"') {
			const quoted = readQuotedArgument(text, index);
			index = quoted?.end ?? text.length;
			continue;
		}
		if (text[index] === "[") {
			const bracket = readBracketBlock(text, index);
			if (bracket) {
				index = bracket.end;
				continue;
			}
		}
		const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(index))?.[0];
		if (!name) {
			index += 1;
			continue;
		}
		const nameStart = index;
		const openParen = skipTrivia(text, index + name.length);
		if (text[openParen] !== "(") {
			index += name.length;
			continue;
		}
		const parsed = parseInvocation(text, name.toLowerCase(), lineAt(starts, nameStart), openParen);
		if (!parsed) {
			index = openParen + 1;
			continue;
		}
		invocations.push(parsed.invocation);
		index = parsed.end;
	}
	return invocations;
}

function literal(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.includes("$")) return null;
	return trimmed.replace(/\\/g, "/");
}

function literalTarget(value: string | undefined): string | null {
	const target = literal(value);
	return target && /^[A-Za-z0-9_.:+-]+$/.test(target) ? target : null;
}

function relativeSpecifier(value: string): string | null {
	if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return null;
	const normalized = value.replace(/^\.\//, "").replace(/\/+$/g, "");
	if (normalized.length === 0) return null;
	return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function sourceSpecifier(value: string | undefined): string | null {
	const path = literal(value);
	if (!path || path.includes(";") || path.startsWith("-") || TARGET_SOURCE_KEYWORDS.has(path.toUpperCase())) return null;
	const withoutQuery = path.split(/[?#]/, 1)[0] ?? path;
	const dot = withoutQuery.lastIndexOf(".");
	if (dot === -1 || !SOURCE_EXTENSIONS.has(withoutQuery.slice(dot).toLowerCase())) return null;
	return relativeSpecifier(path);
}

function childCMakeSpecifier(value: string | undefined): string | null {
	const directory = literal(value);
	if (!directory) return null;
	const relative = relativeSpecifier(directory);
	if (!relative) return null;
	return `${relative}/CMakeLists.txt`.replace(/\/\//g, "/");
}

export function isCMakePath(path: string): boolean {
	const name = path.split("/").at(-1) ?? path;
	return name === "CMakeLists.txt" || name.toLowerCase().endsWith(".cmake");
}

export function extractCMake(text: string): CMakeExtraction {
	const symbols: CMakeExtractedSymbol[] = [];
	const imports: string[] = [];
	for (const invocation of scanInvocations(text)) {
		if (invocation.name === "add_subdirectory") {
			const child = childCMakeSpecifier(invocation.args[0]);
			if (child) imports.push(child);
			continue;
		}
		if (invocation.name === "add_library" || invocation.name === "add_executable") {
			const target = literalTarget(invocation.args[0]);
			if (!target) continue;
			symbols.push({ name: target, kind: "const", line: invocation.line });
			if (invocation.args[1]?.toUpperCase() === "ALIAS") continue;
			for (const arg of invocation.args.slice(1)) {
				const source = sourceSpecifier(arg);
				if (source) imports.push(source);
			}
			continue;
		}
		if (invocation.name === "target_sources") {
			if (!literalTarget(invocation.args[0])) continue;
			for (const arg of invocation.args.slice(1)) {
				const source = sourceSpecifier(arg);
				if (source) imports.push(source);
			}
		}
	}
	return {
		symbols: symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
		imports: uniqueSorted(imports),
	};
}
