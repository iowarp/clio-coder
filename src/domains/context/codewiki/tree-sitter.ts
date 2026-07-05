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

type GrammarName =
	| "typescript"
	| "tsx"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "c"
	| "cpp"
	| "java"
	| "ruby"
	| "c_sharp";

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
	c_sharp: "tree-sitter-c_sharp.wasm",
};

const NAME_NODE_TYPES = new Set([
	"identifier",
	"type_identifier",
	"property_identifier",
	"field_identifier",
	"constant",
	"constant_identifier",
]);

const FUNCTION_LIKE_NODE_TYPES = new Set([
	"function_declaration",
	"function_expression",
	"generator_function",
	"generator_function_declaration",
	"generator_function_expression",
	"arrow_function",
	"method_definition",
	"function_definition",
	"function_item",
	"lambda",
	"lambda_expression",
	"func_literal",
	"method",
	"singleton_method",
	"do_block",
	"method_declaration",
	"constructor_declaration",
	"local_function_statement",
]);

const PY_SCOPE_NODE_TYPES = new Set(["function_definition", "class_definition"]);

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
	if (lang === "c#") return "c_sharp";
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

function hasFunctionLikeAncestor(node: SyntaxNode): boolean {
	let current = node.parent;
	while (current) {
		if (FUNCTION_LIKE_NODE_TYPES.has(current.type)) return true;
		current = current.parent;
	}
	return false;
}

function nearestAncestorType(node: SyntaxNode, types: ReadonlySet<string>): string | null {
	let current = node.parent;
	while (current) {
		if (types.has(current.type)) return current.type;
		current = current.parent;
	}
	return null;
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

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set([...values].filter((value) => value.trim().length > 0))].sort(compareStrings);
}

function cleanStringLiteral(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith("`") && trimmed.endsWith("`")) ||
		(trimmed.startsWith("<") && trimmed.endsWith(">"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function stringValue(node: SyntaxNode | null | undefined): string | null {
	if (!node) return null;
	const value = cleanStringLiteral(node.text);
	return value.length > 0 ? value : null;
}

function firstStringDescendant(node: SyntaxNode | null | undefined): SyntaxNode | null {
	if (!node) return null;
	if (
		node.type === "string" ||
		node.type === "string_literal" ||
		node.type === "interpreted_string_literal" ||
		node.type === "raw_string_literal" ||
		node.type === "system_lib_string"
	) {
		return node;
	}
	for (const child of node.namedChildren) {
		const found = firstStringDescendant(child);
		if (found) return found;
	}
	return null;
}

function firstStringValue(node: SyntaxNode | null | undefined): string | null {
	return stringValue(firstStringDescendant(node));
}

function extractTsJs(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, ["function_declaration", "generator_function_declaration"])) {
		if (hasFunctionLikeAncestor(node)) continue;
		addSymbol(symbols, node, "func");
	}
	for (const node of descendants(root, "class_declaration")) {
		if (hasFunctionLikeAncestor(node)) continue;
		addSymbol(symbols, node, "class");
	}
	for (const node of descendants(root, "interface_declaration")) {
		if (hasFunctionLikeAncestor(node)) continue;
		addSymbol(symbols, node, "iface");
	}
	for (const node of descendants(root, ["type_alias_declaration", "enum_declaration"])) {
		if (hasFunctionLikeAncestor(node)) continue;
		addSymbol(symbols, node, "type");
	}
	for (const node of descendants(root, "method_definition")) {
		// method_definition covers both class methods (parent class_body) and
		// object-literal method shorthand (parent object). Only real class
		// methods on a top-level class belong in the index.
		if (node.parent?.type !== "class_body") continue;
		if (hasFunctionLikeAncestor(node)) continue;
		addSymbol(symbols, node, "method");
	}
	for (const node of descendants(root, "variable_declarator")) {
		if (hasFunctionLikeAncestor(node)) continue;
		const parentText = node.parent?.text ?? "";
		addSymbol(symbols, node, parentText.trimStart().startsWith("const") ? "const" : "var");
	}
	return symbols;
}

function extractPython(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, "function_definition")) {
		// The nearest enclosing scope decides the kind: a class body makes it a
		// method, module level makes it a func, and a function body makes it a
		// local definition that never enters the index.
		const scope = nearestAncestorType(node, PY_SCOPE_NODE_TYPES);
		if (scope === "function_definition") continue;
		addSymbol(symbols, node, scope === "class_definition" ? "method" : "func");
	}
	for (const node of descendants(root, "class_definition")) {
		if (hasFunctionLikeAncestor(node)) continue;
		addSymbol(symbols, node, "class");
	}
	for (const node of descendants(root, "assignment")) {
		if (hasFunctionLikeAncestor(node)) continue;
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
	for (const node of descendants(root, "const_spec")) {
		if (hasFunctionLikeAncestor(node)) continue;
		addSymbol(symbols, node, "const");
	}
	for (const node of descendants(root, "var_spec")) {
		if (hasFunctionLikeAncestor(node)) continue;
		addSymbol(symbols, node, "var");
	}
	return symbols;
}

function extractRust(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, "function_item")) {
		// Function items nested inside another fn body are locals; impl/trait
		// members are methods; everything else is a free function.
		if (hasFunctionLikeAncestor(node)) continue;
		const isMethod = hasAncestor(node, "impl_item") || hasAncestor(node, "trait_item");
		addSymbol(symbols, node, isMethod ? "method" : "func");
	}
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
		// A field_declaration is `modifiers? type declarator (',' declarator)*`.
		// Record each declarator name, never the shared type identifier. Static
		// final fields and SCREAMING_CASE names classify as const.
		const modifiers = node.namedChildren.find((child) => child.type === "modifiers")?.text ?? "";
		const staticFinal = /\bstatic\b/.test(modifiers) && /\bfinal\b/.test(modifiers);
		for (const declarator of node.namedChildren) {
			if (declarator.type !== "variable_declarator") continue;
			const name =
				declarator.childForFieldName("name")?.text ??
				declarator.namedChildren.find((child) => child.type === "identifier")?.text;
			if (!name) continue;
			const isConst = staticFinal || /^[A-Z][A-Z0-9_]*$/.test(name);
			addSymbol(symbols, declarator, isConst ? "const" : "var", name);
		}
	}
	return symbols;
}

function extractRuby(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, ["method", "singleton_method"])) addSymbol(symbols, node, "func");
	for (const node of descendants(root, "class")) addSymbol(symbols, node, "class");
	for (const node of descendants(root, "module")) addSymbol(symbols, node, "type");
	for (const node of descendants(root, "assignment")) {
		if (hasFunctionLikeAncestor(node)) continue;
		const name = nameFromNode(node);
		if (name) addSymbol(symbols, node, /^[A-Z]/.test(name) ? "const" : "var", name);
	}
	return symbols;
}

function extractCSharp(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	for (const node of descendants(root, "class_declaration")) {
		if (!hasFunctionLikeAncestor(node)) addSymbol(symbols, node, "class");
	}
	for (const node of descendants(root, "interface_declaration")) {
		if (!hasFunctionLikeAncestor(node)) addSymbol(symbols, node, "iface");
	}
	for (const node of descendants(root, ["enum_declaration", "struct_declaration", "record_declaration"])) {
		if (!hasFunctionLikeAncestor(node)) addSymbol(symbols, node, "type");
	}
	for (const node of descendants(root, ["method_declaration", "constructor_declaration"]))
		addSymbol(symbols, node, "method");
	for (const node of descendants(root, "property_declaration")) {
		if (hasFunctionLikeAncestor(node)) continue;
		addSymbol(symbols, node, "var");
	}
	for (const node of descendants(root, "field_declaration")) {
		if (hasFunctionLikeAncestor(node)) continue;
		const text = node.text;
		const isConst = /\bconst\b/.test(text) || (/\bstatic\b/.test(text) && /\breadonly\b/.test(text));
		addSymbol(symbols, node, isConst ? "const" : "var");
	}
	return symbols;
}

function extractSymbolsByGrammar(grammar: GrammarName, root: SyntaxNode): ExtractedSymbol[] {
	if (grammar === "typescript" || grammar === "tsx" || grammar === "javascript") return extractTsJs(root);
	if (grammar === "python") return extractPython(root);
	if (grammar === "go") return extractGo(root);
	if (grammar === "rust") return extractRust(root);
	if (grammar === "c" || grammar === "cpp") return extractCFamily(root);
	if (grammar === "java") return extractJava(root);
	if (grammar === "ruby") return extractRuby(root);
	if (grammar === "c_sharp") return extractCSharp(root);
	return [];
}

function extractTsJsImports(root: SyntaxNode): string[] {
	const imports: string[] = [];
	for (const node of descendants(root, "import_statement")) {
		const source = stringValue(node.childForFieldName("source")) ?? firstStringValue(node);
		if (source) imports.push(source);
	}
	for (const node of descendants(root, "export_statement")) {
		const source = stringValue(node.childForFieldName("source"));
		if (source) imports.push(source);
	}
	for (const node of descendants(root, "call_expression")) {
		const callee = node.childForFieldName("function");
		if (!callee || (callee.text !== "require" && callee.text !== "import" && callee.type !== "import")) continue;
		const source = firstStringValue(node.childForFieldName("arguments"));
		if (source) imports.push(source);
	}
	return uniqueSorted(imports);
}

function extractPythonImports(root: SyntaxNode): string[] {
	const imports: string[] = [];
	for (const node of descendants(root, "import_statement")) {
		for (const child of node.namedChildren) {
			if (child.type === "dotted_name") imports.push(child.text);
			if (child.type === "aliased_import") {
				const name = child.childForFieldName("name") ?? child.namedChild(0);
				if (name) imports.push(name.text);
			}
		}
	}
	for (const node of descendants(root, "import_from_statement")) {
		const moduleName =
			node.childForFieldName("module_name") ??
			node.namedChildren.find((child) => child.type === "relative_import" || child.type === "dotted_name");
		if (moduleName) imports.push(moduleName.text);
	}
	return uniqueSorted(imports);
}

function extractGoImports(root: SyntaxNode): string[] {
	const imports: string[] = [];
	for (const node of descendants(root, "import_spec")) {
		const source = stringValue(node.childForFieldName("path"));
		if (source) imports.push(source);
	}
	return uniqueSorted(imports);
}

function extractRustImports(root: SyntaxNode): string[] {
	const imports: string[] = [];
	for (const node of descendants(root, "use_declaration")) {
		const argument = node.childForFieldName("argument") ?? node.namedChild(0);
		if (argument) imports.push(argument.text.trim());
	}
	for (const node of descendants(root, "extern_crate_declaration")) {
		const name = node.childForFieldName("name") ?? node.namedChildren.find((child) => child.type === "identifier");
		if (name) imports.push(name.text.trim());
	}
	return uniqueSorted(imports);
}

function extractCFamilyImports(root: SyntaxNode): string[] {
	const imports: string[] = [];
	for (const node of descendants(root, "preproc_include")) {
		const source = stringValue(node.childForFieldName("path") ?? firstStringDescendant(node));
		if (source) imports.push(source);
	}
	return uniqueSorted(imports);
}

function extractJavaImports(root: SyntaxNode): string[] {
	const imports: string[] = [];
	for (const node of descendants(root, "import_declaration")) {
		const source = node.text
			.replace(/^import\s+/, "")
			.replace(/^static\s+/, "")
			.replace(/;$/, "")
			.trim();
		if (source) imports.push(source);
	}
	return uniqueSorted(imports);
}

function extractRubyImports(root: SyntaxNode): string[] {
	return uniqueSorted([
		...Array.from(root.text.matchAll(/^\s*require\s+["']([^"']+)["']/gm), (match) => match[1] ?? ""),
		...Array.from(root.text.matchAll(/^\s*require_relative\s+["']([^"']+)["']/gm), (match) => `./${match[1] ?? ""}`),
	]);
}

function extractCSharpImports(root: SyntaxNode): string[] {
	const imports: string[] = [];
	for (const node of descendants(root, "using_directive")) {
		let source = node.text
			.replace(/^using\s+/, "")
			.replace(/;$/, "")
			.trim();
		if (source.startsWith("static ")) source = source.slice("static ".length).trim();
		const aliasIndex = source.indexOf("=");
		if (aliasIndex !== -1) source = source.slice(aliasIndex + 1).trim();
		if (source) imports.push(source);
	}
	return uniqueSorted(imports);
}

function extractImportsByGrammar(grammar: GrammarName, root: SyntaxNode): string[] {
	if (grammar === "typescript" || grammar === "tsx" || grammar === "javascript") return extractTsJsImports(root);
	if (grammar === "python") return extractPythonImports(root);
	if (grammar === "go") return extractGoImports(root);
	if (grammar === "rust") return extractRustImports(root);
	if (grammar === "c" || grammar === "cpp") return extractCFamilyImports(root);
	if (grammar === "java") return extractJavaImports(root);
	if (grammar === "ruby") return extractRubyImports(root);
	if (grammar === "c_sharp") return extractCSharpImports(root);
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
		langs: ["typescript", "javascript", "python", "go", "rust", "c", "c++", "java", "ruby", "c#"],
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
			if (!grammar || text.trim().length === 0) return { symbols: [], imports: [] };
			const parser = parsers.get(grammar);
			if (!parser) return { symbols: [], imports: [] };
			let tree: Parser.Tree | null = null;
			try {
				tree = parser.parse(text);
				const symbols = sortSymbols(extractSymbolsByGrammar(grammar, tree.rootNode));
				return {
					symbols,
					imports: extractImportsByGrammar(grammar, tree.rootNode),
				};
			} catch {
				throw new Error(`tree-sitter parse failed for ${path}`);
			} finally {
				tree?.delete();
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
	if (path.endsWith(".cs")) return "c#";
	return "config";
}
