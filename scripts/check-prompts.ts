import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

const allowedTemplateVars = new Set([
	"provider",
	"model",
	"contextWindow",
	"thinkingBudget",
	"sessionNotes",
	"turnCount",
	"clioVersion",
	"piMonoVersion",
]);

const knownFrontmatterKeys = new Set(["id", "version", "budgetTokens", "description", "dynamic"]);
const templateVarRegex = /^[A-Za-z][A-Za-z0-9]*$/;
const fragmentFrontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

interface FragmentFrontmatter {
	id: string;
	version: 1;
	budgetTokens: number;
	description: string;
	dynamic?: boolean;
}

interface TemplateScanResult {
	errors: string[];
	vars: string[];
}

interface ParsedFragment {
	body: string;
	declaredTemplateVars: string[];
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
	const budgetTokens = value.budgetTokens;
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

	if (!Number.isInteger(budgetTokens) || typeof budgetTokens !== "number" || budgetTokens <= 0) {
		errors.push(`${relPath}: frontmatter.budgetTokens must be a positive integer`);
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
		id,
		version: 1,
		budgetTokens,
		description,
		...(dynamic === undefined ? {} : { dynamic }),
	};
}

function scanTemplateVars(body: string): TemplateScanResult {
	const errors: string[] = [];
	const vars = new Set<string>();

	let cursor = 0;
	while (cursor < body.length) {
		const openIndex = body.indexOf("{{", cursor);
		if (openIndex === -1) break;

		const closeIndex = body.indexOf("}}", openIndex + 2);
		if (closeIndex === -1) {
			errors.push(`unclosed template placeholder at offset ${openIndex}`);
			break;
		}

		const candidate = body.slice(openIndex, closeIndex + 2);
		const match = candidate.match(/^{{([A-Za-z][A-Za-z0-9]*)}}$/);
		if (!match) {
			errors.push(`invalid template placeholder "${candidate}"`);
			cursor = openIndex + 2;
			continue;
		}

		const variableName = match[1];
		if (variableName && templateVarRegex.test(variableName)) {
			vars.add(variableName);
		}

		cursor = closeIndex + 2;
	}

	return { errors, vars: [...vars].sort((left, right) => left.localeCompare(right)) };
}

function validateTemplateUsage(
	projectRoot: string,
	filePath: string,
	body: string,
	dynamic: boolean,
	errors: string[],
): string[] {
	const relPath = formatRelative(projectRoot, filePath);
	const scanned = scanTemplateVars(body);

	for (const error of scanned.errors) {
		errors.push(`${relPath}: ${error}`);
	}

	if (!dynamic) {
		if (scanned.vars.length > 0) {
			const joined = scanned.vars.map((name) => `{{${name}}}`).join(", ");
			errors.push(`${relPath}: static fragment must not declare template vars (${joined})`);
		}
		return [];
	}

	for (const variableName of scanned.vars) {
		if (!allowedTemplateVars.has(variableName)) {
			errors.push(`${relPath}: unsupported template var "{{${variableName}}}"`);
		}
	}

	return scanned.vars;
}

function validateBudget(
	projectRoot: string,
	filePath: string,
	body: string,
	budgetTokens: number,
	errors: string[],
): void {
	const relPath = formatRelative(projectRoot, filePath);
	const actualTokens = Math.ceil(body.length / 4);
	if (actualTokens > budgetTokens * 1.1) {
		errors.push(`${relPath}: budget exceeded (${actualTokens} > ${budgetTokens})`);
	}
}

function parseFragment(projectRoot: string, filePath: string, errors: string[]): ParsedFragment {
	const relPath = formatRelative(projectRoot, filePath);
	const raw = readFileSync(filePath, "utf8");
	const split = splitFrontmatter(raw);

	if (!split) {
		errors.push(`${relPath}: missing or malformed YAML frontmatter`);
		return {
			body: raw,
			declaredTemplateVars: [],
			frontmatter: null,
			path: filePath,
		};
	}

	let parsedFrontmatter: unknown;
	try {
		parsedFrontmatter = yaml.parse(split.frontmatterText);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		errors.push(`${relPath}: invalid YAML frontmatter (${reason})`);
		return {
			body: split.body,
			declaredTemplateVars: [],
			frontmatter: null,
			path: filePath,
		};
	}

	const frontmatter = validateFrontmatter(projectRoot, filePath, parsedFrontmatter, errors);
	const declaredTemplateVars =
		frontmatter === null
			? []
			: validateTemplateUsage(projectRoot, filePath, split.body, frontmatter.dynamic === true, errors);

	if (frontmatter !== null) {
		validateBudget(projectRoot, filePath, split.body, frontmatter.budgetTokens, errors);
	}

	return {
		body: split.body,
		declaredTemplateVars,
		frontmatter,
		path: filePath,
	};
}

export function runPromptCheck(projectRoot: string): PromptCheckResult {
	const fragmentsRoot = path.join(projectRoot, "src", "domains", "prompts", "fragments");
	const errors: string[] = [];

	if (!exists(fragmentsRoot)) {
		errors.push("src/domains/prompts/fragments/ missing");
		return {
			dynamicCount: 0,
			errors,
			fragments: [],
			staticCount: 0,
		};
	}

	const fragmentFiles = walkMarkdownFiles(fragmentsRoot);
	const fragments = fragmentFiles.map((filePath) => parseFragment(projectRoot, filePath, errors));

	const seenIds = new Map<string, string>();
	let dynamicCount = 0;
	let staticCount = 0;

	for (const fragment of fragments) {
		if (fragment.frontmatter === null) continue;

		if (fragment.frontmatter.dynamic === true) {
			dynamicCount += 1;
		} else {
			staticCount += 1;
		}

		const previousPath = seenIds.get(fragment.frontmatter.id);
		if (previousPath) {
			errors.push(
				`duplicate fragment id "${fragment.frontmatter.id}" in ${formatRelative(projectRoot, previousPath)} and ${formatRelative(projectRoot, fragment.path)}`,
			);
			continue;
		}

		seenIds.set(fragment.frontmatter.id, fragment.path);
	}

	return {
		dynamicCount,
		errors,
		fragments,
		staticCount,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const result = runPromptCheck(process.cwd());
	if (result.errors.length > 0) {
		console.error(`prompts: FAIL (${result.fragments.length} fragments, ${result.dynamicCount} dynamic)`);
		for (const error of result.errors) {
			console.error(`- ${error}`);
		}
		process.exit(1);
	}

	console.log(`prompts: OK (${result.fragments.length} fragments, ${result.dynamicCount} dynamic)`);
}
