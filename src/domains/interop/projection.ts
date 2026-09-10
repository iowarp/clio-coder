/**
 * Shared per-resource projection for every inbound route: local-agent adoption
 * and explicit foreign package import both turn host text into the same Clio
 * recipe bytes through these helpers. Nothing here writes to a source tree.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseAgentRecipeSchema } from "../agents/index.js";
import { inventoryText } from "./inventory.js";

export const DATA_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".txt", ".rst", ".csv", ".bib"]);
export const FORBIDDEN_PARTS: ReadonlySet<string> = new Set([
	"hooks",
	"output-styles",
	"scripts",
	"tools",
	"node_modules",
	".git",
	".claude-plugin",
	".codex-plugin",
]);
/** Skill frontmatter keys that describe host execution policy, never recipe text. */
export const HOST_SKILL_KEYS: ReadonlyArray<string> = [
	"audit",
	"installed-hash",
	"source-url",
	"installed-by",
	"hooks",
	"mcpServers",
	"allowed-tools",
	"tools",
	"context",
	"agent",
	"model",
	"effort",
	"user-invocable",
	"disable-model-invocation",
	"argument-hint",
	"paths",
	"when_to_use",
];
/** Prompt (command) keys Clio reads; every other host key is reported as omitted. */
const PROMPT_KEYS: ReadonlySet<string> = new Set(["description", "argument-hint", "argumentHint"]);

export function safeName(name: string): string {
	const value = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 45)
		.replace(/-$/u, "");
	if (!value) throw new Error("No safe resource identifier.");
	return value;
}

function safeData(file: string): boolean {
	return !file.split("/").some((part) => FORBIDDEN_PARTS.has(part)) && DATA_EXTENSIONS.has(path.extname(file));
}

/**
 * Bounded text tree. `dataOnly` drops executable, host-specific and non-text
 * files into `omitted` instead of failing; otherwise any of those is fatal.
 */
/** Names of every regular file below `dir`, relative to `root`; symlinks are listed, never followed. */
function listFiles(root: string, dir: string, out: string[], depth = 0): void {
	if (depth > 12 || out.length > 4096) return;
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return;
	}
	for (const name of names) {
		const file = path.join(dir, name);
		const relative = path.relative(root, file).split(path.sep).join("/");
		try {
			const stat = lstatSync(file);
			if (stat.isDirectory()) listFiles(root, file, out, depth + 1);
			else out.push(relative);
		} catch {
			out.push(relative);
		}
	}
}

export function tree(root: string, dataOnly = false, omitted: string[] = []): Record<string, string> {
	const files: Record<string, string> = {};
	let bytes = 0;
	const visit = (dir: string, depth: number): void => {
		if (depth > 12) throw new Error("Source tree exceeds depth limit.");
		if (lstatSync(dir).isSymbolicLink()) throw new Error("Symbolic links are not adoptable.");
		for (const name of readdirSync(dir).sort()) {
			const file = path.join(dir, name);
			const relative = path.relative(root, file).split(path.sep).join("/");
			if (dataOnly && relative.split("/").some((part) => FORBIDDEN_PARTS.has(part) || part === "fleets")) {
				let isDirectory = false;
				try {
					isDirectory = lstatSync(file).isDirectory();
				} catch {
					/* unreadable entries are still listed as omitted */
				}
				if (isDirectory) listFiles(root, file, omitted);
				else omitted.push(relative);
				continue;
			}
			const stat = lstatSync(file);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
				throw new Error("Symbolic links and special files are not adoptable.");
			if (stat.isDirectory()) visit(file, depth + 1);
			else {
				if (dataOnly && relative !== "plugin.json" && (!safeData(relative) || (stat.mode & 0o111) !== 0)) {
					omitted.push(relative);
					continue;
				}
				if ((stat.mode & 0o111) !== 0) throw new Error(`Executable file is not adoptable: ${path.relative(root, file)}`);
				const text = inventoryText(file);
				bytes += Buffer.byteLength(text);
				if (bytes > 16 * 1024 * 1024 || Object.keys(files).length >= 2048)
					throw new Error("Source tree exceeds adoption limits.");
				files[relative] = text;
			}
		}
	};
	visit(root, 0);
	return files;
}

/**
 * Review fingerprint of an entire source tree: every entry's path, type, mode
 * bits and bounded raw bytes, including hidden vendor manifests and omitted
 * runtime files. A change to policy or dependencies never slips past review
 * merely because the projected text stayed equal.
 */
export function reviewFingerprint(root: string): string {
	const hash = createHash("sha256");
	let budget = 64 * 1024 * 1024;
	let count = 0;
	const visit = (dir: string, depth: number): void => {
		if (depth > 12) throw new Error("Source tree exceeds depth limit.");
		for (const name of readdirSync(dir).sort()) {
			if (++count > 8192) throw new Error("Source tree exceeds review limits.");
			const file = path.join(dir, name);
			const relative = path.relative(root, file).split(path.sep).join("/");
			const stat = lstatSync(file);
			hash.update(relative).update("\0");
			if (stat.isSymbolicLink()) hash.update(`symlink:${readlinkSync(file)}`);
			else if (stat.isDirectory()) {
				hash.update("dir");
				visit(file, depth + 1);
			} else if (stat.isFile()) {
				hash.update(`file:${stat.mode & 0o777}:${stat.size}:`);
				budget -= stat.size;
				if (budget < 0) throw new Error("Source tree exceeds review limits.");
				hash.update(readFileSync(file));
			} else hash.update("special");
			hash.update("\0");
		}
	};
	visit(root, 0);
	return hash.digest("hex");
}

export function digest(files: Readonly<Record<string, string>>): string {
	const hash = createHash("sha256");
	for (const key of Object.keys(files).sort())
		hash
			.update(key)
			.update("\0")
			.update(files[key] ?? "")
			.update("\0");
	return hash.digest("hex");
}

export function prose(text: string): { metadata: Record<string, unknown>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
	if (!match) return { metadata: {}, body: text };
	const metadata: unknown = parseYaml(match[1] ?? "");
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
		throw new Error("Invalid resource frontmatter.");
	return { metadata: metadata as Record<string, unknown>, body: match[2] ?? "" };
}

export interface ProjectedResource {
	/** Clio resource id, safe for a component id and a file name. */
	id: string;
	/** Name the host would have used to invoke the resource. */
	name: string;
	/** Files relative to the projected package root. */
	files: Record<string, string>;
	componentPath: string;
	omittedFields: string[];
	omittedFiles: string[];
	/** Companion files the retained text refers to; the recipe is unavailable without them. */
	requiredOmissions: string[];
	/** Skill names the host bound to this resource; the caller decides whether they are satisfiable. */
	bindings: string[];
}

/**
 * Project one skill directory. `source` is the bounded text tree of the skill
 * directory; when `lenient` is set, non-text companions are dropped and
 * reported rather than fatal.
 */
export function projectSkill(input: {
	skillDir: string;
	fallbackName: string;
	lenient?: boolean;
	/** Top-level entries that belong to sibling roots, not to this skill; neither projected nor omitted. */
	excludeTopLevel?: ReadonlySet<string>;
}): ProjectedResource {
	const rawOmitted: string[] = [];
	const rawSource = input.lenient ? tree(input.skillDir, true, rawOmitted) : tree(input.skillDir);
	const foreign = (file: string): boolean => input.excludeTopLevel?.has(file.split("/")[0] ?? "") === true;
	const source = Object.fromEntries(Object.entries(rawSource).filter(([file]) => !foreign(file)));
	const omittedFiles = rawOmitted.filter((file) => !foreign(file));
	delete source["plugin.json"];
	if (!input.lenient && Object.keys(source).some((file) => !safeData(file)))
		throw new Error("Not adoptable: skill contains executable or non-text companion files.");
	const raw = source["SKILL.md"];
	if (raw === undefined) throw new Error("Skill directory has no SKILL.md.");
	const skill = prose(raw);
	const name = typeof skill.metadata.name === "string" && skill.metadata.name.trim() ? skill.metadata.name.trim() : "";
	if (!input.lenient && (!name || typeof skill.metadata.description !== "string"))
		throw new Error("Skill requires name and description frontmatter.");
	if (typeof skill.metadata.description !== "string" || !skill.metadata.description.trim())
		throw new Error("Skill requires description frontmatter.");
	const actualName = name || input.fallbackName;
	const omittedFields: string[] = [];
	// Never carry a foreign audit stamp across the approval boundary.
	for (const key of ["clio-coder", "clio"]) if (key in skill.metadata) delete skill.metadata[key];
	for (const key of HOST_SKILL_KEYS)
		if (key in skill.metadata) {
			omittedFields.push(key);
			delete skill.metadata[key];
		}
	const id = safeName(actualName);
	const body = skill.body;
	// Deterministic reference check over every retained text, not only SKILL.md.
	const retained = [
		body,
		...Object.entries(source)
			.filter(([file]) => file !== "SKILL.md")
			.map(([, text]) => text),
	];
	const requiredOmissions = omittedFiles.filter((file) => {
		const base = path.basename(file);
		return retained.some((text) => text.includes(file) || (base.includes(".") && text.includes(base)));
	});
	source["SKILL.md"] =
		`---\n${stringifyYaml({ ...skill.metadata, name: actualName, "clio-coder": { audit: "unknown" } })}---\n${body}`;
	return {
		id,
		name: actualName,
		files: Object.fromEntries(Object.entries(source).map(([file, text]) => [`skills/${id}/${file}`, text])),
		componentPath: `skills/${id}/SKILL.md`,
		omittedFields,
		omittedFiles,
		requiredOmissions,
		bindings: [],
	};
}

/** Persona-only agent projection; host tools, model, permissions and skill bindings are omitted. */
export function projectAgent(input: {
	file: string;
	name: string;
	text?: string;
	/** Package-local skill names to bind through the real Clio `skills` field. */
	bindSkills?: ReadonlyArray<string>;
}): ProjectedResource {
	if (input.text === undefined && (lstatSync(input.file).mode & 0o111) !== 0)
		throw new Error("Executable files are not adoptable.");
	const raw = input.text ?? inventoryText(input.file);
	const parsed = input.file.endsWith(".toml")
		? (() => {
				const data = parseToml(raw);
				if (typeof data.developer_instructions !== "string") throw new Error("Agent developer_instructions is unknown.");
				return { metadata: data as Record<string, unknown>, body: data.developer_instructions };
			})()
		: prose(raw);
	if (!parsed.body.trim()) throw new Error("Empty resource body.");
	const name =
		typeof parsed.metadata.name === "string" && parsed.metadata.name.trim() ? parsed.metadata.name.trim() : input.name;
	const id = safeName(name);
	const omittedFields = Object.keys(parsed.metadata).filter(
		(key) => !["name", "description", "developer_instructions", ...(input.bindSkills ? ["skills"] : [])].includes(key),
	);
	const metadata: Record<string, unknown> = {
		description: typeof parsed.metadata.description === "string" ? parsed.metadata.description : `Adopted agent ${name}`,
		version: 1,
		name,
		tools: { required: ["read"], optional: ["grep", "find", "ls"] },
		skills: [...(input.bindSkills ?? [])],
		audience: "custom",
		category: "research",
		capabilityClass: "read-only",
		latencyClass: "balanced",
		projectContextTier: "bounded",
		budget: { toolCalls: 24, readReserve: 4, synthesis: true },
		resultContract: { kind: "artifact-report" },
		tags: ["interop"],
	};
	parseAgentRecipeSchema({
		id,
		source: "plugin",
		filepath: input.file,
		body: parsed.body,
		frontmatter: metadata,
	});
	const componentPath = `agents/${id}.md`;
	const declaredSkills = parsed.metadata.skills;
	const bindings = Array.isArray(declaredSkills)
		? declaredSkills.filter((skill): skill is string => typeof skill === "string")
		: typeof declaredSkills === "string"
			? declaredSkills
					.split(",")
					.map((skill) => skill.trim())
					.filter(Boolean)
			: [];
	return {
		id,
		name,
		files: { [componentPath]: `---\n${stringifyYaml(metadata)}---\n${parsed.body}` },
		componentPath,
		omittedFields,
		omittedFiles: [],
		requiredOmissions: [],
		bindings,
	};
}

/** Command markdown becomes a Clio prompt recipe; only description and argument hint survive. */
export function projectPrompt(input: { file: string; name: string; text?: string }): ProjectedResource {
	if (input.text === undefined && (lstatSync(input.file).mode & 0o111) !== 0)
		throw new Error("Executable files are not adoptable.");
	const parsed = prose(input.text ?? inventoryText(input.file));
	if (!parsed.body.trim()) throw new Error("Empty resource body.");
	const name = input.name;
	const id = safeName(name);
	const omittedFields = Object.keys(parsed.metadata).filter((key) => !PROMPT_KEYS.has(key));
	const metadata: Record<string, unknown> = {
		description: typeof parsed.metadata.description === "string" ? parsed.metadata.description : `Adopted prompt ${name}`,
	};
	const hint = parsed.metadata["argument-hint"] ?? parsed.metadata.argumentHint;
	if (typeof hint === "string") metadata["argument-hint"] = hint;
	const componentPath = `prompts/${id}.md`;
	return {
		id,
		name,
		files: { [componentPath]: `---\n${stringifyYaml(metadata)}---\n${parsed.body}` },
		componentPath,
		omittedFields,
		omittedFiles: [],
		requiredOmissions: [],
		bindings: [],
	};
}
