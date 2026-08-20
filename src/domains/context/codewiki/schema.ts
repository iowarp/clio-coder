import type { ProjectType, SourceProjectType } from "../../session/workspace/project-type.js";

export type CodewikiLanguage = SourceProjectType | "config";
export type CodewikiFileRole = "entry" | "test" | "module" | "config";
export type CodewikiSymbolKind = "func" | "class" | "method" | "type" | "const" | "var" | "trait" | "iface";

export interface CodewikiFile {
	id: string;
	path: string;
	lang: CodewikiLanguage;
	loc: number;
	role: CodewikiFileRole;
	hash: string;
	imports: string[];
	summary?: string;
}

export interface CodewikiSymbol {
	name: string;
	kind: CodewikiSymbolKind;
	fileId: string;
	line: number;
	sig?: string;
}

export interface CodewikiInternalEdge {
	fileId: string;
	toFileId: string;
}

export interface CodewikiExternalEdge {
	fileId: string;
	externalModule: string;
}

export type CodewikiEdge = CodewikiInternalEdge | CodewikiExternalEdge;

export const CODEWIKI_VERSION = 5 as const;

export interface Codewiki {
	version: typeof CODEWIKI_VERSION;
	language: ProjectType;
	files: CodewikiFile[];
	symbols: CodewikiSymbol[];
	edges: CodewikiEdge[];
}

export interface CodewikiEntry {
	path: string;
	exports: string[];
	imports: string[];
	kind: "entry-point" | "test" | "module";
	summary?: string;
}

export interface BuildCodewikiInput {
	cwd: string;
	language: ProjectType;
	generatedAt?: string;
}

export type CodewikiReadFile = (path: string) => string | null;

export interface ExtractedSymbol {
	name: string;
	kind: CodewikiSymbolKind;
	line: number;
	sig?: string;
}

export interface LanguageExtraction {
	symbols: ExtractedSymbol[];
	imports: string[];
}

export interface LanguageExtractor {
	langs: ReadonlyArray<CodewikiLanguage>;
	extractImports?(path: string, text: string): string[];
	extract(path: string, text: string): LanguageExtraction;
}
