import { TOOL_FILE_KINDS, type ToolFileKind } from "./schemas.js";

/** Spellings that name the same kind of file as one of the recorded kinds. */
const ALIASES: Readonly<Record<string, ToolFileKind>> = {
	markdown: "md",
	qmd: "md",
	rmd: "md",
	ltx: "tex",
	sty: "tex",
	cls: "tex",
	pyi: "py",
	cc: "cpp",
	cxx: "cpp",
	hpp: "h",
	hh: "h",
	f: "f90",
	f77: "f90",
	f95: "f90",
	mjs: "js",
	cjs: "js",
	jsx: "js",
	tsx: "ts",
	mts: "ts",
	cts: "ts",
	bash: "sh",
	zsh: "sh",
	yml: "yaml",
	hdf5: "h5",
	hdf: "h5",
	he5: "h5",
	nc4: "nc",
	cdf: "nc",
	npz: "npy",
	pq: "parquet",
};

const KINDS: ReadonlySet<string> = new Set(TOOL_FILE_KINDS);

/**
 * The recorded kind of a file from its extension alone. The path is read here and goes no further: the result is a
 * closed vocabulary word, `other` for any extension outside it and for a file with none.
 */
export function toolFileKind(path: string): ToolFileKind {
	const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "other";
	const ext = base.slice(dot + 1).toLowerCase();
	const alias = ALIASES[ext];
	if (alias !== undefined) return alias;
	return KINDS.has(ext) ? (ext as ToolFileKind) : "other";
}
