import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import TreeSitter, {
	type Parser as ParserInstance,
	type Node as SyntaxNode,
	type Tree,
} from "@vscode/tree-sitter-wasm";
import { classifyCHeaderLanguage, isAmbiguousHeaderPath } from "../../../core/c-header-language.js";
import type {
	CodewikiLanguage,
	CodewikiSymbolKind,
	ExtractedSymbol,
	LanguageExtraction,
	LanguageExtractor,
} from "./indexer.js";

const require = createRequire(import.meta.url);
const { Language, Parser } = TreeSitter;
const VSCODE_WASM_DIR = dirname(require.resolve("@vscode/tree-sitter-wasm"));

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
	typescript: join(VSCODE_WASM_DIR, "tree-sitter-typescript.wasm"),
	tsx: join(VSCODE_WASM_DIR, "tree-sitter-tsx.wasm"),
	javascript: join(VSCODE_WASM_DIR, "tree-sitter-javascript.wasm"),
	python: join(VSCODE_WASM_DIR, "tree-sitter-python.wasm"),
	go: join(VSCODE_WASM_DIR, "tree-sitter-go.wasm"),
	rust: join(VSCODE_WASM_DIR, "tree-sitter-rust.wasm"),
	// VS Code does not currently ship a C grammar; its runtime accepts this
	// ABI-compatible compact C side module from tree-sitter-wasms.
	c: require.resolve("tree-sitter-wasms/out/tree-sitter-c.wasm"),
	cpp: join(VSCODE_WASM_DIR, "tree-sitter-cpp.wasm"),
	java: join(VSCODE_WASM_DIR, "tree-sitter-java.wasm"),
	ruby: join(VSCODE_WASM_DIR, "tree-sitter-ruby.wasm"),
	c_sharp: join(VSCODE_WASM_DIR, "tree-sitter-c-sharp.wasm"),
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
			return join(VSCODE_WASM_DIR, "tree-sitter.wasm");
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

function namedChildren(node: SyntaxNode): SyntaxNode[] {
	return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function firstNamedDescendant(node: SyntaxNode, types: ReadonlySet<string> = NAME_NODE_TYPES): SyntaxNode | null {
	if (types.has(node.type)) return node;
	for (const child of namedChildren(node)) {
		const found = firstNamedDescendant(child, types);
		if (found) return found;
	}
	return null;
}

function nameFromNode(node: SyntaxNode): string | null {
	const direct = node.childForFieldName("name");
	if (direct) return firstNamedDescendant(direct)?.text ?? direct.text;
	for (const child of namedChildren(node)) {
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
	return root.descendantsOfType(types).filter((node): node is SyntaxNode => node !== null);
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
	for (const child of namedChildren(node)) {
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

const C_FAMILY_CLASS_SCOPES = new Set(["class_specifier", "struct_specifier", "union_specifier"]);

function cFamilyDeclaredTypeName(node: SyntaxNode): string | null {
	// Aggregate bodies contain field/type identifiers of their own. A missing
	// name field means the aggregate is anonymous; never fall through into its
	// body looking for a plausible identifier.
	const name = node.childForFieldName("name");
	return name ? name.text.trim() || null : null;
}

function cFamilyDeclaratorName(node: SyntaxNode): string | null {
	if (NAME_NODE_TYPES.has(node.type)) return node.text.trim() || null;

	// Pointer, array, parenthesized, and function declarators all wrap the
	// declared identifier in their `declarator` field. Following only that
	// chain avoids mistaking a function-pointer parameter for the typedef name.
	const declarator = node.childForFieldName("declarator") ?? node.childForFieldName("name");
	if (declarator) return cFamilyDeclaratorName(declarator);

	// Some grammar versions omit the field on transparent parentheses. Those
	// nodes have one declarator-shaped named child, so a narrow fallback remains
	// safe without searching arbitrary aggregate bodies or parameter lists.
	if (
		node.type === "parenthesized_declarator" ||
		node.type === "abstract_parenthesized_declarator" ||
		node.type === "attributed_declarator"
	) {
		for (const child of namedChildren(node)) {
			const name = cFamilyDeclaratorName(child);
			if (name) return name;
		}
	}
	return null;
}

function cFamilyDeclarators(node: SyntaxNode): SyntaxNode[] {
	return node.childrenForFieldName("declarator").filter((child): child is SyntaxNode => child !== null);
}

function uniqueCFamilySymbols(symbols: ReadonlyArray<ExtractedSymbol>): ExtractedSymbol[] {
	const unique = new Map<string, ExtractedSymbol>();
	for (const symbol of symbols) {
		const key = `${symbol.name}\0${symbol.kind}\0${symbol.line}`;
		if (!unique.has(key)) unique.set(key, symbol);
	}
	return [...unique.values()];
}

function cFamilyFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
	// The symbol name lives in the declarator, never in the return type; a
	// pointer or reference declarator can wrap the function_declarator. Walk
	// deepest-first so a function returning a function pointer resolves the
	// inner callable while a plain function-pointer variable is rejected.
	const declarator = node.childForFieldName("declarator");
	if (!declarator) return null;
	const candidates = [
		...(declarator.type === "function_declarator" ? [declarator] : []),
		...declarator.descendantsOfType("function_declarator"),
	];
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		const inner = candidate?.childForFieldName("declarator");
		if (inner && inner.type !== "parenthesized_declarator") return candidate ?? null;
	}
	return null;
}

function cFamilyFunctionName(node: SyntaxNode): string | null {
	const fnDeclarator = cFamilyFunctionDeclarator(node);
	const inner = fnDeclarator?.childForFieldName("declarator");
	if (!inner) return null;
	let name: SyntaxNode = inner;
	while (name.type === "qualified_identifier") {
		const unqualified = name.childForFieldName("name");
		if (!unqualified) break;
		name = unqualified;
	}
	if (name.type === "template_function") name = name.childForFieldName("name") ?? name;
	return name.text;
}

function cFamilyFunctionQualifier(node: SyntaxNode): string | null {
	const inner = cFamilyFunctionDeclarator(node)?.childForFieldName("declarator");
	if (inner?.type !== "qualified_identifier") return null;
	const parts = inner.text.split("::");
	parts.pop();
	return parts.join("::") || null;
}

function cFamilyQualifiedMethod(
	node: SyntaxNode,
	classNames: ReadonlySet<string>,
	namespaceNames: ReadonlySet<string>,
): boolean {
	const qualifier = cFamilyFunctionQualifier(node);
	if (!qualifier) return false;
	const last = qualifier.split("::").at(-1) ?? qualifier;
	if (classNames.has(last)) return true;
	if (namespaceNames.has(last) || namespaceNames.has(qualifier)) return false;
	// Tree-sitter represents namespace and class qualification identically when
	// the declaration lives in an included header. Scientific C++ conventionally
	// uses type-like capitalization for classes and lowercase namespaces.
	return /^[A-Z_]/.test(last);
}

function extractCFamily(root: SyntaxNode): ExtractedSymbol[] {
	const symbols: ExtractedSymbol[] = [];
	const classNames = new Set(
		descendants(root, ["class_specifier", "struct_specifier", "union_specifier"])
			.map((node) => cFamilyDeclaredTypeName(node))
			.filter((name): name is string => name !== null),
	);
	const namespaceNames = new Set(
		descendants(root, "namespace_definition")
			.map((node) => nameFromNode(node))
			.filter((name): name is string => name !== null),
	);
	for (const node of descendants(root, "function_definition")) {
		const kind =
			nearestAncestorType(node, C_FAMILY_CLASS_SCOPES) || cFamilyQualifiedMethod(node, classNames, namespaceNames)
				? "method"
				: "func";
		addSymbol(symbols, node, kind, cFamilyFunctionName(node) ?? nameFromNode(node));
	}
	for (const node of descendants(root, ["declaration", "field_declaration"])) {
		if (hasFunctionLikeAncestor(node)) continue;
		const name = cFamilyFunctionName(node);
		if (!name) continue;
		const isTypedef = namedChildren(node).some(
			(child) => child.type === "storage_class_specifier" && child.text === "typedef",
		);
		const kind = isTypedef
			? "type"
			: nearestAncestorType(node, C_FAMILY_CLASS_SCOPES) || cFamilyQualifiedMethod(node, classNames, namespaceNames)
				? "method"
				: "func";
		addSymbol(symbols, node, kind, name);
	}
	for (const node of descendants(root, ["class_specifier", "struct_specifier", "union_specifier", "enum_specifier"])) {
		const name = cFamilyDeclaredTypeName(node);
		if (name) addSymbol(symbols, node, node.type === "class_specifier" ? "class" : "type", name);
	}
	for (const node of descendants(root, "type_definition")) {
		if (hasFunctionLikeAncestor(node)) continue;
		for (const declarator of cFamilyDeclarators(node)) {
			const name = cFamilyDeclaratorName(declarator);
			if (name) addSymbol(symbols, node, "type", name);
		}
	}
	for (const node of descendants(root, "alias_declaration")) {
		if (hasFunctionLikeAncestor(node)) continue;
		const name = node.childForFieldName("name")?.text.trim();
		if (name) addSymbol(symbols, node, "type", name);
	}
	return uniqueCFamilySymbols(symbols);
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
		const modifiers = namedChildren(node).find((child) => child.type === "modifiers")?.text ?? "";
		const staticFinal = /\bstatic\b/.test(modifiers) && /\bfinal\b/.test(modifiers);
		for (const declarator of namedChildren(node)) {
			if (declarator.type !== "variable_declarator") continue;
			const name =
				declarator.childForFieldName("name")?.text ??
				namedChildren(declarator).find((child) => child.type === "identifier")?.text;
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
		for (const child of namedChildren(node)) {
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
			namedChildren(node).find((child) => child.type === "relative_import" || child.type === "dotted_name");
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
		const name = node.childForFieldName("name") ?? namedChildren(node).find((child) => child.type === "identifier");
		if (name) imports.push(name.text.trim());
	}
	return uniqueSorted(imports);
}

function extractCFamilyImports(root: SyntaxNode): string[] {
	const imports: string[] = [];
	for (const node of descendants(root, "preproc_include")) {
		const sourceNode = node.childForFieldName("path") ?? firstStringDescendant(node);
		const source = stringValue(sourceNode);
		if (!source) continue;
		const quoted = sourceNode?.text.trim().startsWith('"') === true;
		imports.push(quoted && !source.startsWith(".") && !source.startsWith("/") ? `./${source}` : source);
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

function grammarForSourceFile(path: string, text: string): GrammarName | null {
	if (isAmbiguousHeaderPath(path)) return classifyCHeaderLanguage(text) === "c++" ? "cpp" : "c";
	return grammarForPath(path, languageFromPath(path));
}

function grammarCandidatesForSourceFile(path: string): GrammarName[] {
	// Ambiguous headers resolve to C or C++ from content at extraction time,
	// so preloading must cover both grammars a header can select.
	if (isAmbiguousHeaderPath(path)) return ["c", "cpp"];
	const grammar = grammarForPath(path, languageFromPath(path));
	return grammar ? [grammar] : [];
}

export interface TreeSitterExtractor extends LanguageExtractor {
	ensureGrammarsForPaths(paths: ReadonlyArray<string>): Promise<void>;
}

export async function createTreeSitterExtractor(): Promise<TreeSitterExtractor> {
	await ensureParserInit();
	const parsers = new Map<GrammarName, ParserInstance>();
	const loading = new Map<GrammarName, Promise<void>>();
	const loadGrammar = (grammar: GrammarName): Promise<void> => {
		if (parsers.has(grammar)) return Promise.resolve();
		let pending = loading.get(grammar);
		if (!pending) {
			pending = Language.load(WASM_BY_GRAMMAR[grammar])
				.then((language) => {
					const parser = new Parser();
					parser.setLanguage(language);
					parsers.set(grammar, parser);
				})
				.finally(() => {
					loading.delete(grammar);
				});
			loading.set(grammar, pending);
		}
		return pending;
	};
	return {
		langs: ["typescript", "javascript", "python", "go", "rust", "c", "c++", "java", "ruby", "c#"],
		async ensureGrammarsForPaths(paths: ReadonlyArray<string>): Promise<void> {
			const needed = new Set<GrammarName>();
			for (const path of paths) {
				for (const grammar of grammarCandidatesForSourceFile(path)) needed.add(grammar);
			}
			await Promise.all([...needed].map(loadGrammar));
		},
		extract(path: string, text: string): LanguageExtraction {
			const grammar = grammarForSourceFile(path, text);
			if (!grammar || text.trim().length === 0) return { symbols: [], imports: [] };
			const parser = parsers.get(grammar);
			// A missing parser means the caller skipped ensureGrammarsForPaths for this
			// path; throwing routes the file to the regex fallback instead of silently
			// indexing it with zero symbols.
			if (!parser) throw new Error(`tree-sitter grammar not loaded for ${path}`);
			let tree: Tree | null = null;
			try {
				const parsed = parser.parse(text);
				if (!parsed) throw new Error(`tree-sitter returned no tree for ${path}`);
				tree = parsed;
				const symbols = sortSymbols(extractSymbolsByGrammar(grammar, parsed.rootNode));
				return {
					symbols,
					imports: extractImportsByGrammar(grammar, parsed.rootNode),
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
	if (/\.(cc|cpp|cxx|hpp|hh|hxx|cu|cuh)$/.test(path)) return "c++";
	if (/\.(c|h)$/.test(path)) return "c";
	if (path.endsWith(".java")) return "java";
	if (path.endsWith(".rb")) return "ruby";
	if (path.endsWith(".cs")) return "c#";
	return "config";
}
