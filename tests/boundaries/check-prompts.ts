import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

// `budgetTokens` is accepted but no longer enforced; legacy fragments still
// carry it. Identity.clio is intentionally untouched per the revamp plan.
const knownFrontmatterKeys = new Set(["id", "version", "description", "dynamic", "budgetTokens"]);
const fragmentFrontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

interface FragmentFrontmatter {
	id: string;
	version: 1;
	description: string;
	dynamic?: boolean;
}

interface ParsedFragment {
	body: string;
	frontmatter: FragmentFrontmatter | null;
	path: string;
}

export interface PromptCheckResult {
	dynamicCount: number;
	errors: string[];
	fragments: ParsedFragment[];
	staticCount: number;
}

function exists(targetPath: string): boolean {
	try {
		statSync(targetPath);
		return true;
	} catch {
		return false;
	}
}

function walkMarkdownFiles(root: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkMarkdownFiles(fullPath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(fullPath);
		}
	}

	return files.sort((left, right) => left.localeCompare(right));
}

function formatRelative(projectRoot: string, filePath: string): string {
	return path.relative(projectRoot, filePath);
}

function splitFrontmatter(raw: string): { body: string; frontmatterText: string } | null {
	const match = raw.match(fragmentFrontmatterRegex);
	if (!match) return null;

	const frontmatterText = match[1];
	const body = match[2];
	if (frontmatterText === undefined || body === undefined) return null;

	return { frontmatterText, body };
}

function isFrontmatterObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFrontmatter(
	projectRoot: string,
	filePath: string,
	value: unknown,
	errors: string[],
): FragmentFrontmatter | null {
	const relPath = formatRelative(projectRoot, filePath);

	if (!isFrontmatterObject(value)) {
		errors.push(`${relPath}: frontmatter must be a YAML object`);
		return null;
	}

	for (const key of Object.keys(value)) {
		if (!knownFrontmatterKeys.has(key)) {
			errors.push(`${relPath}: unknown frontmatter key "${key}"`);
		}
	}

	const id = value.id;
	const version = value.version;
	const description = value.description;
	const dynamic = value.dynamic;

	let valid = true;

	if (typeof id !== "string" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(id)) {
		errors.push(`${relPath}: frontmatter.id must be a dot-separated string namespace`);
		valid = false;
	}

	if (version !== 1) {
		errors.push(`${relPath}: frontmatter.version must be 1`);
		valid = false;
	}

	if (typeof description !== "string" || description.trim() === "") {
		errors.push(`${relPath}: frontmatter.description must be a non-empty string`);
		valid = false;
	}

	if (dynamic !== undefined && typeof dynamic !== "boolean") {
		errors.push(`${relPath}: frontmatter.dynamic must be a boolean when present`);
		valid = false;
	}

	if (!valid) return null;

	return {
		id: id as string,
		version: 1,
		description: description as string,
		...(dynamic === undefined ? {} : { dynamic: dynamic as boolean }),
	};
}

function parseFragment(projectRoot: string, filePath: string, errors: string[]): ParsedFragment {
	const relPath = formatRelative(projectRoot, filePath);
	const raw = readFileSync(filePath, "utf8");
	const split = splitFrontmatter(raw);

	if (!split) {
		errors.push(`${relPath}: missing or malformed YAML frontmatter`);
		return { body: raw, frontmatter: null, path: filePath };
	}

	let parsedFrontmatter: unknown;
	try {
		parsedFrontmatter = yaml.parse(split.frontmatterText);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		errors.push(`${relPath}: invalid YAML frontmatter (${reason})`);
		return { body: split.body, frontmatter: null, path: filePath };
	}

	const frontmatter = validateFrontmatter(projectRoot, filePath, parsedFrontmatter, errors);

	return { body: split.body, frontmatter, path: filePath };
}

/**
 * Validate every prompt fragment under src/domains/prompts/fragments: YAML
 * frontmatter shape, id uniqueness, budget adherence, and template variable usage.
 */
export function runPromptCheck(projectRoot: string): PromptCheckResult {
	const fragmentsRoot = path.join(projectRoot, "src", "domains", "prompts", "fragments");
	const errors: string[] = [];

	if (!exists(fragmentsRoot)) {
		errors.push("src/domains/prompts/fragments/ missing");
		return { dynamicCount: 0, errors, fragments: [], staticCount: 0 };
	}

	const fragmentFiles = walkMarkdownFiles(fragmentsRoot);
	const fragments = fragmentFiles.map((filePath) => parseFragment(projectRoot, filePath, errors));

	const seenIds = new Map<string, string>();
	let dynamicCount = 0;
	let staticCount = 0;

	for (const fragment of fragments) {
		if (fragment.frontmatter === null) continue;

		if (fragment.frontmatter.dynamic === true) dynamicCount += 1;
		else staticCount += 1;

		const previousPath = seenIds.get(fragment.frontmatter.id);
		if (previousPath) {
			errors.push(
				`duplicate fragment id "${fragment.frontmatter.id}" in ${formatRelative(projectRoot, previousPath)} and ${formatRelative(projectRoot, fragment.path)}`,
			);
			continue;
		}

		seenIds.set(fragment.frontmatter.id, fragment.path);
	}

	return { dynamicCount, errors, fragments, staticCount };
}
