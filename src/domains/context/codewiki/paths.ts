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
