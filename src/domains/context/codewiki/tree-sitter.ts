import { createRequire } from "node:module";
import Parser from "web-tree-sitter";
import type {
	CodewikiLanguage,
	CodewikiSymbolKind,
	ExtractedSymbol,
	LanguageExtraction,
	LanguageExtractor,
} from "./indexer.js";

type SyntaxNode = Parser.SyntaxNode;

const require = createRequire(import.meta.url);

type GrammarName = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "c" | "cpp" | "java" | "ruby";

const WASM_BY_GRAMMAR: Record<GrammarName, string> = {
	typescript: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	javascript: "tree-sitter-javascript.wasm",
	python: "tree-sitter-python.wasm",
	go: "tree-sitter-go.wasm",
	rust: "tree-sitter-rust.wasm",
	c: "tree-sitter-c.wasm",
	cpp: "tree-sitter-cpp.wasm",
	java: "tree-sitter-java.wasm",
	ruby: "tree-sitter-ruby.wasm",
};

const NAME_NODE_TYPES = new Set([
	"identifier",
	"type_identifier",
	"property_identifier",
	"field_identifier",
	"constant",
	"constant_identifier",
]);

let parserInit: Promise<void> | null = null;

function ensureParserInit(): Promise<void> {
	parserInit ??= Parser.init({
		locateFile() {
			return require.resolve("web-tree-sitter/tree-sitter.wasm");
		},
	});
	return parserInit;
}

function grammarForPath(path: string, lang: CodewikiLanguage): GrammarName | null {
	if (lang === "typescript") return path.endsWith(".tsx") ? "tsx" : "typescript";
	if (lang === "javascript") return "javascript";
	if (lang === "python") return "python";
	if (lang === "go") return "go";
	if (lang === "rust") return "rust";
	if (lang === "c") return "c";
	if (lang === "c++") return "cpp";
	if (lang === "java") return "java";
	if (lang === "ruby") return "ruby";
	return null;
}

function line(node: SyntaxNode): number {
	return node.startPosition.row + 1;
}

function sig(node: SyntaxNode): string {
	return node.text.split(/\r?\n/, 1)[0]?.trim().slice(0, 240) ?? "";
}

function firstNamedDescendant(node: SyntaxNode, types: ReadonlySet<string> = NAME_NODE_TYPES): SyntaxNode | null {
	if (types.has(node.type)) return node;
	for (const child of node.namedChildren) {
		const found = firstNamedDescendant(child, types);
		if (found) return found;
	}
	return null;
}

function nameFromNode(node: SyntaxNode): string | null {
	const direct = node.childForFieldName("name");
	if (direct) return firstNamedDescendant(direct)?.text ?? direct.text;
	for (const child of node.namedChildren) {
		if (NAME_NODE_TYPES.has(child.type)) return child.text;
	}
	return firstNamedDescendant(node)?.text ?? null;
}

function hasAncestor(node: SyntaxNode, type: string): boolean {
	let current = node.parent;
	while (current) {
		if (current.type === type) return true;
		current = current.parent;
	}
	return false;
}

function addSymbol(
	target: ExtractedSymbol[],
	node: SyntaxNode,
	kind: CodewikiSymbolKind,
	name = nameFromNode(node),
): void {
	if (!name) return;
	const clean = name.trim();
	if (clean.length === 0) return;
	target.push({ name: clean, kind, line: line(node), sig: sig(node) });
}

function descendants(root: SyntaxNode, types: string | string[]): SyntaxNode[] {
	return root.descendantsOfType(types);
}

function extractTsJs(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, ["function_declaration", "generator_function_declaration"])) {
		addSymbol(symbols, node, "func");
	}
	for (const node of descendants(root, "class_declaration")) addSymbol(symbols, node, "class");
	for (const node of descendants(root, "interface_declaration")) addSymbol(symbols, node, "iface");
	for (const node of descendants(root, ["type_alias_declaration", "enum_declaration"])) addSymbol(symbols, node, "type");
	for (const node of descendants(root, "method_definition")) addSymbol(symbols, node, "method");
	for (const node of descendants(root, "variable_declarator")) {
		const parentText = node.parent?.text ?? "";
		addSymbol(symbols, node, parentText.trimStart().startsWith("const") ? "const" : "var");
	}
	return symbols;
}

function extractPython(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, "function_definition")) {
		addSymbol(symbols, node, hasAncestor(node, "class_definition") ? "method" : "func");
	}
	for (const node of descendants(root, "class_definition")) addSymbol(symbols, node, "class");
	for (const node of descendants(root, "assignment")) {
		const left = node.childForFieldName("left") ?? node.namedChild(0);
		if (!left) continue;
		const name = firstNamedDescendant(left)?.text;
		if (name) addSymbol(symbols, node, /^[A-Z][A-Z0-9_]*$/.test(name) ? "const" : "var", name);
	}
	return symbols;
}

function extractGo(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, "function_declaration")) addSymbol(symbols, node, "func");
	for (const node of descendants(root, "method_declaration")) addSymbol(symbols, node, "method");
	for (const node of descendants(root, "type_spec")) {
		addSymbol(symbols, node, node.text.includes("interface") ? "iface" : "type");
	}
	for (const node of descendants(root, "const_spec")) addSymbol(symbols, node, "const");
	for (const node of descendants(root, "var_spec")) addSymbol(symbols, node, "var");
	return symbols;
}

function extractRust(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, "function_item")) addSymbol(symbols, node, "func");
	for (const node of descendants(root, ["struct_item", "enum_item", "type_item"])) addSymbol(symbols, node, "type");
	for (const node of descendants(root, "trait_item")) addSymbol(symbols, node, "trait");
	for (const node of descendants(root, "const_item")) addSymbol(symbols, node, "const");
	for (const node of descendants(root, "static_item")) addSymbol(symbols, node, "var");
	return symbols;
}

function extractCFamily(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, "function_definition")) addSymbol(symbols, node, "func");
	for (const node of descendants(root, ["class_specifier", "struct_specifier", "enum_specifier"])) {
		addSymbol(symbols, node, node.type === "class_specifier" ? "class" : "type");
	}
	return symbols;
}

function extractJava(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, "class_declaration")) addSymbol(symbols, node, "class");
	for (const node of descendants(root, "interface_declaration")) addSymbol(symbols, node, "iface");
	for (const node of descendants(root, "enum_declaration")) addSymbol(symbols, node, "type");
	for (const node of descendants(root, "method_declaration")) addSymbol(symbols, node, "method");
	for (const node of descendants(root, "field_declaration")) {
		const name = nameFromNode(node);
		if (name) addSymbol(symbols, node, /^[A-Z][A-Z0-9_]*$/.test(name) ? "const" : "var", name);
	}
	return symbols;
}

function extractRuby(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, ["method", "singleton_method"])) addSymbol(symbols, node, "func");
	for (const node of descendants(root, "class")) addSymbol(symbols, node, "class");
	for (const node of descendants(root, "module")) addSymbol(symbols, node, "type");
	for (const node of descendants(root, "assignment")) {
		const name = nameFromNode(node);
		if (name) addSymbol(symbols, node, /^[A-Z]/.test(name) ? "const" : "var", name);
	}
	return symbols;
}

function extractByGrammar(grammar: GrammarName, root: SyntaxNode): ExtractedSymbol[] {
	if (grammar === "typescript" || grammar === "tsx" || grammar === "javascript") return extractTsJs(root);
	if (grammar === "python") return extractPython(root);
	if (grammar === "go") return extractGo(root);
	if (grammar === "rust") return extractRust(root);
	if (grammar === "c" || grammar === "cpp") return extractCFamily(root);
	if (grammar === "java") return extractJava(root);
	if (grammar === "ruby") return extractRuby(root);
	return [];
}

function sortSymbols(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
	return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

export async function createTreeSitterExtractor(): Promise<LanguageExtractor> {
	await ensureParserInit();
	const parsers = new Map<GrammarName, Parser>();
	for (const [grammar, wasmName] of Object.entries(WASM_BY_GRAMMAR) as Array<[GrammarName, string]>) {
		const language = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${wasmName}`));
		const parser = new Parser();
		parser.setLanguage(language);
		parsers.set(grammar, parser);
	}
	return {
		langs: ["typescript", "javascript", "python", "go", "rust", "c", "c++", "java", "ruby"],
		extract(path: string, text: string): LanguageExtraction {
			const lang = path.endsWith(".tsx")
				? "typescript"
				: path.endsWith(".jsx")
					? "javascript"
					: path.endsWith(".cpp") || path.endsWith(".cc") || path.endsWith(".cxx") || path.endsWith(".hpp")
						? "c++"
						: path.endsWith(".c") || path.endsWith(".h")
							? "c"
							: null;
			const grammar = grammarForPath(path, lang ?? languageFromPath(path));
			if (!grammar || text.trim().length === 0) return { symbols: [], imports: [], exports: [] };
			const parser = parsers.get(grammar);
			if (!parser) return { symbols: [], imports: [], exports: [] };
			const tree = parser.parse(text);
			try {
				const symbols = sortSymbols(extractByGrammar(grammar, tree.rootNode));
				return { symbols, imports: [], exports: symbols.map((symbol) => symbol.name) };
			} finally {
				tree.delete();
			}
		},
	};
}

function languageFromPath(path: string): CodewikiLanguage {
	if (/\.[cm]?tsx?$/.test(path)) return "typescript";
	if (/\.[cm]?jsx?$/.test(path)) return "javascript";
	if (path.endsWith(".py") || path.endsWith(".pyw")) return "python";
	if (path.endsWith(".go")) return "go";
	if (path.endsWith(".rs")) return "rust";
	if (/\.(cc|cpp|cxx|hpp|hh|hxx)$/.test(path)) return "c++";
	if (/\.(c|h)$/.test(path)) return "c";
	if (path.endsWith(".java")) return "java";
	if (path.endsWith(".rb")) return "ruby";
	return "config";
}
