import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { TomlTable } from "smol-toml";

type SmolTomlModule = typeof import("smol-toml");

const require = createRequire(import.meta.url);
let parse: SmolTomlModule["parse"] | undefined;

function parser(): SmolTomlModule["parse"] {
	parse ??= (require("smol-toml") as SmolTomlModule).parse;
	return parse;
}

/** Parse one TOML document, returning no structure when the input is malformed. */
export function parseTomlDocument(raw: string): TomlTable | null {
	try {
		return parser()(raw);
	} catch {
		return null;
	}
}

function isTomlTable(value: unknown): value is TomlTable {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Resolve a structural table path from a parsed document. */
export function tomlTableAt(document: TomlTable, path: ReadonlyArray<string>): TomlTable | null {
	let value: unknown = document;
	for (const segment of path) {
		if (!isTomlTable(value) || !Object.hasOwn(value, segment)) return null;
		value = value[segment];
	}
	return isTomlTable(value) ? value : null;
}

export interface TomlFileReader {
	read(relativePath: string): TomlTable | null;
}

/**
 * Create an operation-scoped TOML reader. Each relative path is read and
 * parsed at most once, including missing and malformed files.
 */
export function createTomlFileReader(root: string): TomlFileReader {
	const documents = new Map<string, TomlTable | null>();
	return {
		read(relativePath) {
			if (documents.has(relativePath)) return documents.get(relativePath) ?? null;
			let document: TomlTable | null = null;
			try {
				document = parseTomlDocument(readFileSync(join(root, relativePath), "utf8"));
			} catch {
				document = null;
			}
			documents.set(relativePath, document);
			return document;
		},
	};
}
