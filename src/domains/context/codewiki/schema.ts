import type { ProjectType, SourceProjectType } from "../../session/workspace/project-type.js";

export type CodewikiLanguage = SourceProjectType | "config";
export type CodewikiFileRole = "entry" | "test" | "module" | "config";
export type CodewikiSymbolKind = "func" | "class" | "method" | "type" | "const" | "var" | "trait" | "iface";

export interface CodewikiFile {
	id: string;
	path: string;
	lang: CodewikiLanguage;
	loc: number;
	bytes?: number;
	role: CodewikiFileRole;
	hash: string;
	imports: string[];
	summary?: string;
	/**
	 * Set on every file of a language whose tree-sitter grammar Clio downloads on
	 * first use: true when that grammar could not be loaded when the file was
	 * indexed, so its symbols and imports came from line patterns. Recorded per
	 * file because the grammar may have been held only in memory, by whichever
	 * process indexed it. Absent on other languages and on files indexed before
	 * Clio recorded it.
	 */
	grammarMissing?: boolean;
}

export interface CodewikiSymbol {
	name: string;
	kind: CodewikiSymbolKind;
	fileId: string;
	line: number;
	sig?: string;
	/** Explicit export or public declaration; absent when visibility is unknown. */
	exported?: boolean;
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
	exported?: boolean;
}

export interface LanguageExtraction {
	symbols: ExtractedSymbol[];
	imports: string[];
}

/** An extractor without the grammar for a file throws this; the indexer records it on the file. */
export class GrammarUnavailableError extends Error {
	override name = "GrammarUnavailableError";
}

export interface LanguageExtractor {
	langs: ReadonlyArray<CodewikiLanguage>;
	extractImports?(path: string, text: string): string[];
	extract(path: string, text: string): LanguageExtraction;
}
