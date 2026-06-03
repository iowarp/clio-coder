import { clioTheme } from "../theme/index.js";
import { tryRenderJson, tryRenderXml } from "./structured.js";

const COMMON_KEYWORDS = new Set([
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"def",
	"else",
	"export",
	"false",
	"for",
	"from",
	"function",
	"if",
	"import",
	"in",
	"interface",
	"let",
	"match",
	"new",
	"none",
	"null",
	"return",
	"throw",
	"true",
	"try",
	"type",
	"undefined",
	"while",
]);

function commentStart(line: string, lang: string): number {
	if (lang === "python" || lang === "py" || lang === "bash" || lang === "sh" || lang === "shell") {
		return line.indexOf("#");
	}
	return line.indexOf("//");
}

function highlightCodeLine(line: string, lang: string): string {
	const theme = clioTheme();
	const commentAt = commentStart(line, lang);
	const head = commentAt >= 0 ? line.slice(0, commentAt) : line;
	const tail = commentAt >= 0 ? theme.fg("dim", line.slice(commentAt)) : "";
	const token = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|-?\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/gu;
	const highlighted = head.replace(token, (part) => {
		if (/^["'`]/u.test(part)) return theme.fg("success", part);
		if (/^-?\d/u.test(part)) return theme.fg("info", part);
		if (COMMON_KEYWORDS.has(part.toLowerCase())) return theme.fg("reason", part);
		return part;
	});
	return `${highlighted}${tail}`;
}

export function highlightCode(code: string, lang?: string): string[] {
	const normalized = (lang ?? "").trim().toLowerCase();
	if (normalized === "json" || normalized === "jsonc") {
		const rendered = tryRenderJson(code, 120, { lineLimit: 80 });
		if (rendered) return rendered;
	}
	if (normalized === "xml" || normalized === "html") {
		const rendered = tryRenderXml(code, 120, { lineLimit: 80 });
		if (rendered) return rendered;
	}
	return code.split("\n").map((line) => highlightCodeLine(line, normalized));
}
