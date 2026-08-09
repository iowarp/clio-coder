/**
 * What a repository says about itself, read from whatever file its ecosystem
 * puts that in.
 *
 * The handbook used to ask two files: `package.json` for a description and
 * `README.md` for a fallback paragraph. That covers Node and nothing else. A
 * CMake project states its purpose in `project(... DESCRIPTION ...)`, a Python
 * project in `pyproject.toml`, a Fortran or C++ simulation code often only in
 * `CITATION.cff` or a Doxygen `PROJECT_BRIEF`, and plenty of scientific
 * repositories ship `README.rst` or no README at all. Every one of those read
 * as "this project describes itself nowhere", which handed the identity line to
 * a model guessing from directory names.
 *
 * Every reader here is a small, total function over one file format. None of
 * them throw: a malformed manifest is the same as an absent one, because the
 * caller's alternative is a worse guess, not a better error.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Longest description worth carrying into a one-sentence identity line. */
const MAX_DESCRIPTION_CHARS = 400;
/** Longest project name worth carrying. */
const MAX_NAME_CHARS = 80;

export interface ProjectMetadata {
	name: string | null;
	description: string | null;
	/** Repo-relative file the name came from, for provenance in diagnostics. */
	nameSource: string | null;
	/** Repo-relative file the description came from. */
	descriptionSource: string | null;
}

interface MetadataFragment {
	name?: string | null;
	description?: string | null;
}

type MetadataReader = (cwd: string) => { file: string; fragment: MetadataFragment } | null;

function readText(cwd: string, relative: string): string | null {
	try {
		return readFileSync(join(cwd, relative), "utf8");
	} catch {
		return null;
	}
}

function clean(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const collapsed = value.replace(/\s+/gu, " ").trim();
	if (collapsed.length === 0) return null;
	return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

function name(value: unknown): string | null {
	return clean(value, MAX_NAME_CHARS);
}

function description(value: unknown): string | null {
	return clean(value, MAX_DESCRIPTION_CHARS);
}

function jsonRecord(cwd: string, relative: string): Record<string, unknown> | null {
	const raw = readText(cwd, relative);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * One key from one TOML table, without a TOML parser.
 *
 * Deliberately narrow: it reads `key = "value"` (single-line, single- or
 * double-quoted) from the named top-level table and understands nothing else.
 * That is the entire shape `description` and `name` take in `pyproject.toml`
 * and `Cargo.toml`. A multi-line or otherwise exotic value reads as absent,
 * which costs a description and never produces a wrong one.
 */
function tomlTableValue(raw: string, table: string, key: string): string | null {
	const lines = raw.split(/\r?\n/u);
	let inTable = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) {
			inTable = trimmed === `[${table}]`;
			continue;
		}
		if (!inTable) continue;
		const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(trimmed);
		if (!match || match[1] !== key) continue;
		const value = (match[2] ?? "").trim();
		const quoted = /^"((?:[^"\\]|\\.)*)"$/u.exec(value) ?? /^'([^']*)'$/u.exec(value);
		if (!quoted) return null;
		return (quoted[1] ?? "").replace(/\\"/gu, '"');
	}
	return null;
}

/** One `KEY = value` line from a Doxyfile or an INI-shaped config. */
function keyEqualsValue(raw: string, key: string): string | null {
	const match = new RegExp(`^[ \\t]*${key}[ \\t]*(?:\\+?=)[ \\t]*(.+)$`, "mu").exec(raw);
	const value = match?.[1]?.trim();
	if (!value) return null;
	return value.replace(/^"(.*)"$/su, "$1").trim();
}

/** One key from the named INI section, used for `setup.cfg`. */
function iniSectionValue(raw: string, section: string, key: string): string | null {
	const lines = raw.split(/\r?\n/u);
	let inSection = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			inSection = trimmed === `[${section}]`;
			continue;
		}
		if (!inSection) continue;
		const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(trimmed);
		if (!match || match[1] !== key) continue;
		const value = (match[2] ?? "").trim();
		return value.length > 0 ? value : null;
	}
	return null;
}

function xmlTagValue(raw: string, tag: string): string | null {
	const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(raw);
	return match?.[1] ?? null;
}

function yamlRecord(cwd: string, relative: string): Record<string, unknown> | null {
	const raw = readText(cwd, relative);
	if (raw === null) return null;
	try {
		const parsed: unknown = parseYaml(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

const packageJson: MetadataReader = (cwd) => {
	const record = jsonRecord(cwd, "package.json");
	if (!record) return null;
	return { file: "package.json", fragment: { name: name(record.name), description: description(record.description) } };
};

const pyprojectToml: MetadataReader = (cwd) => {
	const raw = readText(cwd, "pyproject.toml");
	if (raw === null) return null;
	// PEP 621 `[project]` first, then Poetry's older table.
	const projectName = tomlTableValue(raw, "project", "name") ?? tomlTableValue(raw, "tool.poetry", "name");
	const projectDescription =
		tomlTableValue(raw, "project", "description") ?? tomlTableValue(raw, "tool.poetry", "description");
	return {
		file: "pyproject.toml",
		fragment: { name: name(projectName), description: description(projectDescription) },
	};
};

const cargoToml: MetadataReader = (cwd) => {
	const raw = readText(cwd, "Cargo.toml");
	if (raw === null) return null;
	return {
		file: "Cargo.toml",
		fragment: {
			name: name(tomlTableValue(raw, "package", "name")),
			description: description(tomlTableValue(raw, "package", "description")),
		},
	};
};

const setupCfg: MetadataReader = (cwd) => {
	const raw = readText(cwd, "setup.cfg");
	if (raw === null) return null;
	return {
		file: "setup.cfg",
		fragment: {
			name: name(iniSectionValue(raw, "metadata", "name")),
			description: description(iniSectionValue(raw, "metadata", "description")),
		},
	};
};

const composerJson: MetadataReader = (cwd) => {
	const record = jsonRecord(cwd, "composer.json");
	if (!record) return null;
	return {
		file: "composer.json",
		fragment: { name: name(record.name), description: description(record.description) },
	};
};

const pomXml: MetadataReader = (cwd) => {
	const raw = readText(cwd, "pom.xml");
	if (raw === null) return null;
	return {
		file: "pom.xml",
		fragment: {
			name: name(xmlTagValue(raw, "name") ?? xmlTagValue(raw, "artifactId")),
			description: description(xmlTagValue(raw, "description")),
		},
	};
};

/**
 * `project(<name> [LANGUAGES ...] [VERSION ...] [DESCRIPTION "..."])`, the
 * closest thing a C, C++, CUDA, or Fortran repository has to a manifest.
 */
const cmakeLists: MetadataReader = (cwd) => {
	const raw = readText(cwd, "CMakeLists.txt");
	if (raw === null) return null;
	const call = /^[ \t]*project[ \t]*\(([\s\S]*?)\)/imu.exec(raw)?.[1];
	if (!call) return { file: "CMakeLists.txt", fragment: {} };
	const projectName = /^\s*([A-Za-z0-9_.+-]+)/u.exec(call)?.[1];
	const projectDescription = /\bDESCRIPTION\s+"((?:[^"\\]|\\.)*)"/u.exec(call)?.[1];
	return {
		file: "CMakeLists.txt",
		fragment: { name: name(projectName), description: description(projectDescription) },
	};
};

/** Doxygen's `PROJECT_BRIEF`, often the only prose a Fortran or C++ code ships. */
const doxyfile: MetadataReader = (cwd) => {
	for (const relative of ["Doxyfile", "Doxyfile.in", "docs/Doxyfile", "doc/Doxyfile"]) {
		const raw = readText(cwd, relative);
		if (raw === null) continue;
		return {
			file: relative,
			fragment: {
				name: name(keyEqualsValue(raw, "PROJECT_NAME")),
				description: description(keyEqualsValue(raw, "PROJECT_BRIEF")),
			},
		};
	}
	return null;
};

/** R's `DESCRIPTION`, an RFC-822-shaped file rather than a TOML or JSON one. */
const rDescription: MetadataReader = (cwd) => {
	const raw = readText(cwd, "DESCRIPTION");
	if (raw === null || !/^Package:\s*\S/mu.test(raw)) return null;
	const field = (key: string): string | null => {
		const match = new RegExp(`^${key}:[ \\t]*([\\s\\S]*?)(?=\\n\\S|$)`, "mu").exec(raw);
		return match?.[1] ?? null;
	};
	return {
		file: "DESCRIPTION",
		fragment: {
			name: name(field("Package")),
			description: description(field("Title") ?? field("Description")),
		},
	};
};

const gemspec: MetadataReader = (cwd) => {
	let entries: string[];
	try {
		entries = readdirSync(cwd).filter((entry) => entry.endsWith(".gemspec"));
	} catch {
		return null;
	}
	entries.sort();
	const relative = entries[0];
	if (!relative) return null;
	const raw = readText(cwd, relative);
	if (raw === null) return null;
	const field = (key: string): string | null =>
		new RegExp(`\\.${key}\\s*=\\s*["']([^"']+)["']`, "u").exec(raw)?.[1] ?? null;
	return {
		file: relative,
		fragment: { name: name(field("name")), description: description(field("summary") ?? field("description")) },
	};
};

/**
 * `CITATION.cff` and `codemeta.json`, the metadata scientific software actually
 * maintains. A repository with neither a package manifest nor a README very
 * often still has one of these, because a journal or a funder asked for it.
 */
const citationCff: MetadataReader = (cwd) => {
	const record = yamlRecord(cwd, "CITATION.cff");
	if (!record) return null;
	return { file: "CITATION.cff", fragment: { name: name(record.title), description: description(record.abstract) } };
};

const codemetaJson: MetadataReader = (cwd) => {
	const record = jsonRecord(cwd, "codemeta.json");
	if (!record) return null;
	return { file: "codemeta.json", fragment: { name: name(record.name), description: description(record.description) } };
};

const zenodoJson: MetadataReader = (cwd) => {
	const record = jsonRecord(cwd, ".zenodo.json");
	if (!record) return null;
	return { file: ".zenodo.json", fragment: { name: name(record.title), description: description(record.description) } };
};

/**
 * Manifests before prose, and within manifests, the file the project's own
 * toolchain reads before the file a metadata standard asked for. A description
 * field is a sentence someone wrote to answer this exact question; a README
 * paragraph is whatever happened to come first.
 */
const METADATA_READERS: ReadonlyArray<MetadataReader> = [
	packageJson,
	pyprojectToml,
	cargoToml,
	setupCfg,
	composerJson,
	pomXml,
	cmakeLists,
	doxyfile,
	rDescription,
	gemspec,
	citationCff,
	codemetaJson,
	zenodoJson,
];

/**
 * README variants, in the order a reader would try them. Extensionless `README`
 * is last because a repository that ships both a formatted and a plain one
 * means the formatted one.
 */
const README_CANDIDATES: ReadonlyArray<string> = [
	"README.md",
	"README.rst",
	"README.adoc",
	"README.asciidoc",
	"README.org",
	"README.txt",
	"README.markdown",
	"README",
	"readme.md",
	"readme.rst",
	"readme.txt",
	"docs/README.md",
	"docs/index.rst",
	"doc/README.md",
];

export function findReadme(cwd: string): { path: string; content: string } | null {
	for (const candidate of README_CANDIDATES) {
		if (!existsSync(join(cwd, candidate))) continue;
		const content = readText(cwd, candidate);
		if (content !== null && content.trim().length > 0) return { path: candidate, content };
	}
	return null;
}

/**
 * Strip the markup a README uses to decorate its opening: badges, images,
 * anchors, HTML banners, and emphasis. What survives is the sentence the author
 * wrote. Handles Markdown, reStructuredText, and AsciiDoc with one pass,
 * because the constructs being removed do not collide across the three.
 */
function stripReadmeMarkup(raw: string): string {
	return raw
		.replace(/<!--[\s\S]*?-->/gu, "")
		.replace(/<picture\b[\s\S]*?<\/picture>/giu, "")
		.replace(/^\s*<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>\s*$/gimu, "")
		.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/gu, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/<img\b[^>]*>/giu, "")
		.replace(/<[^>]+>/gu, "")
		// reStructuredText directives and roles: `.. image::`, `|badge|`, `:ref:`.
		.replace(/^\s*\.\.\s+\S+::.*(?:\n(?:[ \t]+.*)?)*/gmu, "")
		.replace(/^\s*\.\.\s+_?\|?[^\n]*\|?:.*$/gmu, "")
		.replace(/\|[A-Za-z0-9_-]+\|/gu, "")
		.replace(/:[a-z]+:`([^`]*)`/gu, "$1")
		// AsciiDoc attribute lines and block macros.
		.replace(/^\s*:[A-Za-z0-9_-]+:.*$/gmu, "")
		.replace(/^\s*image:{1,2}[^\n]*$/gmu, "")
		.replace(/[*_~`]/gu, "");
}

/** True for a line that is a heading or an underline rather than prose. */
function isStructuralLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length === 0) return true;
	if (/^#{1,6}\s+/u.test(trimmed)) return true;
	if (/^={1,6}\s+/u.test(trimmed)) return true;
	// reStructuredText and Setext underlines: ===, ---, ~~~, ^^^, and friends.
	if (/^[=\-~^"'#*+_]{3,}$/u.test(trimmed)) return true;
	if (/^[-|:\s]+$/u.test(trimmed)) return true;
	return false;
}

/**
 * The first paragraph of a README that reads like a description of the project,
 * with headings, underlines, badge rows, and tables removed.
 */
export function readmeSummary(content: string): string | null {
	const paragraphs = stripReadmeMarkup(content)
		.split(/\n\s*\n/u)
		.map((part) =>
			part
				.split(/\r?\n/u)
				.filter((line) => !isStructuralLine(line))
				.join(" ")
				.trim(),
		)
		.filter(
			(part) =>
				part.length >= 20 && /[A-Za-z]{3}/u.test(part) && !part.startsWith("```") && !/^table of contents$/iu.test(part),
		);
	const first = paragraphs[0];
	if (!first) return null;
	return description(first.replace(/\.$/u, ""));
}

/**
 * The first heading a README declares, used as a project name when no manifest
 * names one. Understands Markdown `#`, Setext underlines, and AsciiDoc `=`.
 */
function readmeTitle(content: string): string | null {
	const lines = stripReadmeMarkup(content).split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const line = (lines[index] ?? "").trim();
		if (line.length === 0) continue;
		const hash = /^#{1,3}\s+(.+?)\s*$/u.exec(line)?.[1] ?? /^={1,3}\s+(.+?)\s*$/u.exec(line)?.[1];
		if (hash) return name(hash);
		const next = (lines[index + 1] ?? "").trim();
		if (/^[=\-~^]{3,}$/u.test(next) && !isStructuralLine(line)) return name(line);
		return null;
	}
	return null;
}

/**
 * Read every metadata source this repository happens to have and take the
 * first answer to each question. Name and description resolve independently:
 * a CMake project that names itself but describes itself only in its README
 * should get both, not one or neither.
 */
export function readProjectMetadata(cwd: string): ProjectMetadata {
	const out: ProjectMetadata = { name: null, description: null, nameSource: null, descriptionSource: null };
	for (const reader of METADATA_READERS) {
		if (out.name !== null && out.description !== null) break;
		let read: ReturnType<MetadataReader>;
		try {
			read = reader(cwd);
		} catch {
			continue;
		}
		if (!read) continue;
		if (out.name === null && read.fragment.name) {
			out.name = read.fragment.name;
			out.nameSource = read.file;
		}
		if (out.description === null && read.fragment.description) {
			out.description = read.fragment.description;
			out.descriptionSource = read.file;
		}
	}
	if (out.name !== null && out.description !== null) return out;
	const readme = findReadme(cwd);
	if (!readme) return out;
	if (out.name === null) {
		const title = readmeTitle(readme.content);
		if (title) {
			out.name = title;
			out.nameSource = readme.path;
		}
	}
	if (out.description === null) {
		const summary = readmeSummary(readme.content);
		if (summary) {
			out.description = summary;
			out.descriptionSource = readme.path;
		}
	}
	return out;
}
