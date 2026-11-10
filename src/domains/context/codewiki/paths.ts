import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { SourceProjectType } from "../../session/workspace/project-type.js";
import { EXCLUDED_DIRS } from "../excluded-dirs.js";
import type { CodewikiLanguage } from "./schema.js";

const SOURCE_EXTENSIONS = new Map<string, SourceProjectType>([
	[".ts", "typescript"],
	[".tsx", "typescript"],
	[".mts", "typescript"],
	[".cts", "typescript"],
	[".js", "javascript"],
	[".jsx", "javascript"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".py", "python"],
	[".pyw", "python"],
	[".rs", "rust"],
	[".go", "go"],
	[".c", "c"],
	[".h", "c"],
	[".cc", "c++"],
	[".cpp", "c++"],
	[".cxx", "c++"],
	[".hpp", "c++"],
	[".hh", "c++"],
	[".hxx", "c++"],
	[".cu", "c++"],
	[".cuh", "c++"],
	[".java", "java"],
	[".rb", "ruby"],
	[".cs", "c#"],
]);

const CONFIG_FILE_NAMES = new Set([
	"package.json",
	"pyproject.toml",
	"setup.py",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"CMakeLists.txt",
	"compile_commands.json",
	"Gemfile",
]);

function extensionOf(name: string): string {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index);
}

function sourceLanguageForPath(relPath: string): SourceProjectType | null {
	if (relPath.endsWith(".d.ts")) return null;
	return SOURCE_EXTENSIONS.get(extensionOf(relPath)) ?? null;
}

export function languageForPath(relPath: string): CodewikiLanguage | null {
	const source = sourceLanguageForPath(relPath);
	if (source) return source;
	const name = relPath.split("/").pop() ?? relPath;
	return CONFIG_FILE_NAMES.has(name) || name.endsWith(".csproj") || name.toLowerCase().endsWith(".cmake")
		? "config"
		: null;
}

export function isIndexablePath(relPath: string): boolean {
	if (relPath.split("/").some((segment) => EXCLUDED_DIRS.has(segment))) return false;
	return languageForPath(relPath) !== null;
}

/**
 * Files above this size are indexed as present with no symbols. Reading one
 * whole into a string can exceed V8's string limit and the host's memory; such
 * files are generated or vendored, never hand-written navigation targets.
 */
const MAX_INDEXED_FILE_BYTES = 2 * 1024 * 1024;

interface StreamedFile {
	/** Full sha256 hex digest of the file's bytes, identical to hashing the whole buffer. */
	digest: string;
	bytes: number;
	/** Count of newline bytes. */
	newlines: number;
	endsWithNewline: boolean;
}

/** Size of a regular file over the index gate, or null for anything indexable whole. */
export function oversizeFileBytes(path: string): number | null {
	try {
		const stats = statSync(path);
		return stats.isFile() && stats.size > MAX_INDEXED_FILE_BYTES ? stats.size : null;
	} catch {
		return null;
	}
}

/** Hash and count lines in fixed-size chunks so no whole-file buffer or string is held. */
const STREAM_CHUNK = Buffer.allocUnsafe(1024 * 1024);

export function streamFile(path: string): StreamedFile {
	const hash = createHash("sha256");
	const chunk = STREAM_CHUNK;
	const fd = openSync(path, "r");
	let bytes = 0;
	let newlines = 0;
	let last = -1;
	try {
		for (;;) {
			const read = readSync(fd, chunk, 0, chunk.length, null);
			if (read === 0) break;
			const view = chunk.subarray(0, read);
			hash.update(view);
			bytes += read;
			for (let index = view.indexOf(10); index !== -1; index = view.indexOf(10, index + 1)) newlines += 1;
			last = view[read - 1] ?? last;
		}
	} finally {
		closeSync(fd);
	}
	return { digest: hash.digest("hex"), bytes, newlines, endsWithNewline: last === 10 };
}
