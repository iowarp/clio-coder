import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import { sha256 } from "./hash.js";

/**
 * A single prompt fragment loaded from disk, with parsed frontmatter plus the
 * raw content hash used to seed the prompts domain's reproducibility contract.
 */
export interface LoadedFragment {
	path: string;
	relPath: string;
	id: string;
	version: number;
	description: string;
	dynamic: boolean;
	body: string;
	contentHash: string;
}

export interface FragmentTable {
	byId: ReadonlyMap<string, LoadedFragment>;
	rootDir: string;
}

const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const fragmentIdRegex = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

function defaultRootDir(): string {
	return path.join(resolvePackageRoot(), "src", "domains", "prompts", "fragments");
}

function walk(root: string): string[] {
	const out: string[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(full));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md")) {
			out.push(full);
		}
	}
	return out.sort((left, right) => left.localeCompare(right));
}

function parseFragment(filePath: string, rootDir: string): LoadedFragment {
	const raw = readFileSync(filePath, "utf8");
	// Normalize to POSIX forward slashes so staticCompositionHash is identical
	// across Windows and POSIX hosts.
	const rawRel = path.relative(rootDir, filePath);
	const relPath = rawRel.split(path.sep).join("/");
	const match = raw.match(frontmatterRegex);
	if (!match) {
		throw new Error(`fragment-loader: ${relPath}: missing or malformed YAML frontmatter`);
	}
	const frontmatterText = match[1] ?? "";
	const body = match[2] ?? "";

	let parsed: unknown;
	try {
		parsed = yaml.parse(frontmatterText);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`fragment-loader: ${relPath}: invalid YAML frontmatter (${reason})`);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`fragment-loader: ${relPath}: frontmatter must be a YAML object`);
	}
	const fm = parsed as Record<string, unknown>;

	const id = fm.id;
	if (typeof id !== "string" || !fragmentIdRegex.test(id)) {
		throw new Error(`fragment-loader: ${relPath}: frontmatter.id must be a dot-separated namespace`);
	}
	const version = fm.version;
	if (version !== 1) {
		throw new Error(`fragment-loader: ${relPath}: frontmatter.version must be 1`);
	}
	const description = fm.description;
	if (typeof description !== "string" || description.trim() === "") {
		throw new Error(`fragment-loader: ${relPath}: frontmatter.description must be a non-empty string`);
	}
	const dynamicRaw = fm.dynamic;
	if (dynamicRaw !== undefined && typeof dynamicRaw !== "boolean") {
		throw new Error(`fragment-loader: ${relPath}: frontmatter.dynamic must be a boolean when present`);
	}

	return {
		path: filePath,
		relPath,
		id,
		version,
		description,
		dynamic: dynamicRaw === true,
		body,
		contentHash: sha256(raw),
	};
}

/**
 * Walk `src/domains/prompts/fragments/**\/*.md` (relative to the package root
 * or the supplied `rootDir`) and return a fragment table keyed by id.
 *
 * Duplicate ids throw; malformed or policy-violating fragments throw with a
 * relPath-qualified error so that the prompts compiler never receives a
 * partially loaded table.
 */
export function loadFragments(rootDir?: string): FragmentTable {
	const resolvedRoot = rootDir ? path.resolve(rootDir) : defaultRootDir();
	const files = walk(resolvedRoot);
	const byId = new Map<string, LoadedFragment>();
	for (const file of files) {
		const fragment = parseFragment(file, resolvedRoot);
		const existing = byId.get(fragment.id);
		if (existing) {
			throw new Error(
				`fragment-loader: duplicate fragment id "${fragment.id}" in ${existing.relPath} and ${fragment.relPath}`,
			);
		}
		byId.set(fragment.id, fragment);
	}
	return { byId, rootDir: resolvedRoot };
}
