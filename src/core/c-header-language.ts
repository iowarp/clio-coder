/**
 * Shared deterministic C/C++ classification for ambiguous `.h` headers. The decision
 * uses only file content, so full builds and incremental updates that see the
 * same bytes always agree.
 */

export type CHeaderLanguage = "c" | "c++";

/** `.h` is the only extension whose language depends on file content. */
export function isAmbiguousHeaderPath(path: string): boolean {
	return path.endsWith(".h");
}

// Standard library headers that only exist in C++. The <name.h> C forms
// (stdio.h, stdlib.h, ...) intentionally stay out of this set.
const CPP_ONLY_STD_INCLUDES = new Set([
	"algorithm",
	"any",
	"array",
	"atomic",
	"barrier",
	"bit",
	"bitset",
	"cassert",
	"cctype",
	"cerrno",
	"cfenv",
	"cfloat",
	"charconv",
	"chrono",
	"cinttypes",
	"climits",
	"clocale",
	"cmath",
	"codecvt",
	"compare",
	"complex",
	"concepts",
	"condition_variable",
	"coroutine",
	"csetjmp",
	"csignal",
	"cstdarg",
	"cstddef",
	"cstdint",
	"cstdio",
	"cstdlib",
	"cstring",
	"ctime",
	"cuchar",
	"cwchar",
	"cwctype",
	"deque",
	"exception",
	"execution",
	"expected",
	"filesystem",
	"flat_map",
	"flat_set",
	"format",
	"forward_list",
	"fstream",
	"functional",
	"future",
	"generator",
	"initializer_list",
	"iomanip",
	"ios",
	"iosfwd",
	"iostream",
	"istream",
	"iterator",
	"latch",
	"limits",
	"list",
	"locale",
	"map",
	"mdspan",
	"memory",
	"memory_resource",
	"mutex",
	"new",
	"numbers",
	"numeric",
	"optional",
	"ostream",
	"print",
	"queue",
	"random",
	"ranges",
	"ratio",
	"regex",
	"scoped_allocator",
	"semaphore",
	"set",
	"shared_mutex",
	"source_location",
	"span",
	"spanstream",
	"sstream",
	"stack",
	"stacktrace",
	"stdexcept",
	"stop_token",
	"streambuf",
	"string",
	"string_view",
	"syncstream",
	"system_error",
	"thread",
	"tuple",
	"type_traits",
	"typeindex",
	"typeinfo",
	"unordered_map",
	"unordered_set",
	"utility",
	"valarray",
	"variant",
	"vector",
	"version",
]);

// Each pattern is C++-only syntax that cannot appear in a valid C header
// outside comments and string literals, which the scanner blanks first. An
// `extern "C"` wrapper matches none of them, so wrapped C headers stay C.
const CPP_SYNTAX_PATTERNS: ReadonlyArray<RegExp> = [
	/\bnamespace\s+[A-Za-z_{:]/,
	/\btemplate\s*</,
	/\btypename\b/,
	/\bclass\s+[A-Za-z_]/,
	/\benum\s+(?:class|struct)\b/,
	/\w::~?[A-Za-z_~]/,
	/::/,
	/^\s*(?:public|private|protected)\s*:(?!:)/m,
	/\b(?:static_cast|dynamic_cast|reinterpret_cast|const_cast)\s*</,
	/\busing\s+[A-Za-z_]\w*\s*=/,
	/\busing\s+namespace\b/,
	/\boperator\s*(?:[+\-*/%^&|~!=<>]|\(\)|\[\])/,
	/\b(?:constexpr|consteval|constinit|noexcept|nullptr|decltype|thread_local)\b/,
	/\b(?:virtual|override|friend|mutable)\b/,
	/\)\s*(?:const|noexcept|override|final)\b/,
	/^[ \t]*[A-Za-z_]\w*(?:::\w+)*(?:\s*<[^;{}()]+>)?\s*&&?\s*[A-Za-z_]\w*\s*\([^;{}]*\)\s*;/m,
	/\bauto\s+[A-Za-z_]\w*\s*\([^;{}]*\)\s*->/,
];

interface ScanText {
	/** Comments blanked, string and character literals preserved. */
	withStrings: string;
	/** Comments plus string and character literals blanked. */
	code: string;
}

function blank(ch: string): string {
	return ch === "\n" ? "\n" : " ";
}

function stripForScan(text: string): ScanText {
	let withStrings = "";
	let code = "";
	type State = "code" | "line-comment" | "block-comment" | "string" | "char";
	let state: State = "code";
	for (let index = 0; index < text.length; index += 1) {
		const ch = text[index] as string;
		const next = text[index + 1];
		if (state === "code") {
			if (ch === "/" && next === "/") {
				state = "line-comment";
				withStrings += " ";
				code += " ";
				continue;
			}
			if (ch === "/" && next === "*") {
				state = "block-comment";
				withStrings += " ";
				code += " ";
				continue;
			}
			if (ch === '"') state = "string";
			else if (ch === "'") state = "char";
			withStrings += ch;
			code += state === "code" ? ch : " ";
			continue;
		}
		if (state === "line-comment") {
			if (ch === "\n") state = "code";
			withStrings += blank(ch);
			code += blank(ch);
			continue;
		}
		if (state === "block-comment") {
			if (ch === "*" && next === "/") {
				state = "code";
				index += 1;
				withStrings += " ";
				code += " ";
				continue;
			}
			withStrings += blank(ch);
			code += blank(ch);
			continue;
		}
		// string or char literal
		if (ch === "\\" && next !== undefined) {
			withStrings += ch + next;
			code += blank(ch) + blank(next);
			index += 1;
			continue;
		}
		if ((state === "string" && ch === '"') || (state === "char" && ch === "'") || ch === "\n") {
			state = "code";
			withStrings += ch;
			code += blank(ch);
			continue;
		}
		withStrings += ch;
		code += blank(ch);
	}
	return { withStrings, code };
}

function hasCppInclude(withStrings: string): boolean {
	for (const match of withStrings.matchAll(/^[ \t]*#[ \t]*include[ \t]*([<"])([^>"\n]+)[>"]/gm)) {
		const delimiter = match[1];
		const target = match[2]?.trim() ?? "";
		if (/\.(?:hpp|hh|hxx|cuh)$/.test(target)) return true;
		if (delimiter === "<" && CPP_ONLY_STD_INCLUDES.has(target)) return true;
	}
	return false;
}

function hasCppMemberDeclaration(code: string): boolean {
	for (const match of code.matchAll(/\b(?:class|struct)\s+[A-Za-z_]\w*[^;{]*\{([\s\S]*?)\}/g)) {
		const body = match[1] ?? "";
		for (const rawStatement of body.split(";")) {
			const statement = rawStatement.trim();
			if (statement.length === 0 || /\(\s*[*&]/.test(statement)) continue;
			const member =
				/(?:^|\s)(operator\s*[^\s(]+|~?[A-Za-z_]\w*)\s*\([^{};]*\)\s*(?:const\b|noexcept\b|override\b|final\b|=\s*0\s*)*$/.exec(
					statement,
				);
			if (!member) continue;
			const name = member[1] ?? "";
			const prefix = statement.slice(0, member.index);
			if (prefix.includes("[") || /^[_A-Z][_A-Z0-9]*$/.test(name)) continue;
			return true;
		}
	}
	return false;
}

/**
 * Classify an ambiguous header as C or C++ from its content. Multiple
 * independent C++-only markers are checked; a header with none of them,
 * including a pure C header inside an `extern "C"` wrapper, remains C.
 */
export function classifyCHeaderLanguage(text: string): CHeaderLanguage {
	const { withStrings, code } = stripForScan(text);
	if (hasCppInclude(withStrings)) return "c++";
	if (hasCppMemberDeclaration(code)) return "c++";
	for (const pattern of CPP_SYNTAX_PATTERNS) {
		if (pattern.test(code)) return "c++";
	}
	return "c";
}
